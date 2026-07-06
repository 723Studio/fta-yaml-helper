import { EventEmitter } from 'events';
import { existsSync } from 'fs';
import { glob } from 'glob';
import {
    ConfigurationTarget,
    Disposable,
    ExtensionContext,
    FileSystemWatcher,
    FileType,
    Progress,
    RelativePattern,
    Uri,
    WorkspaceFolder,
    window,
    workspace,
} from 'vscode';
import { parse } from 'yaml2';
import { reporter } from './extension';
import { logger } from './logger';
import { rulesetDefinitionChecker } from './rulesetDefinitionChecker';
import { rulesetFileCacheManager } from './rulesetFileCacheManager';
import { rulesetParser } from './rulesetParser';
import { Definition, LogicDataEntry, Match, Translation, Variables, rulesetTree } from './rulesetTree';

export type ParsedRuleset = {
    definitions?: Definition[];
    references?: Match[];
    variables?: Variables;
    translations: Translation[];
    logicData?: LogicDataEntry[];
};

export class FileNotInWorkspaceError extends Error {}

export class RulesetResolver implements Disposable {
    private loaded = false;
    private context?: ExtensionContext;
    private fileSystemWatcher?: FileSystemWatcher;
    private yamlPattern = '**/*.rul';
    private readonly onDidLoadEmitter: EventEmitter = new EventEmitter();
    private readonly onDidRefreshEmitter: EventEmitter = new EventEmitter();
    private rulesetHierarchy: { [key: string]: Uri } = {};
    private processingFiles: { [key: string]: boolean } = {};
    private deletingFiles: { [key: string]: boolean } = {};
    private savedFiles: { [key: string]: boolean } = {};

    public isLoaded() {
        return this.loaded;
    }

    public setExtensionContent(context: ExtensionContext): void {
        this.context = context;
        rulesetFileCacheManager.setExtensionContent(context);
    }

    public async load(progress: Progress<{ message?: string; increment?: number }>) {
        this.init();
        const start = new Date();

        progress.report({ increment: 0 });

        this.onDidLoadRulesheet(this.ruleSheetLoaded.bind(this, progress));

        // eslint-disable-next-line no-debugger
        // debugger;
        // console.profile();
        await this.loadYamlFiles();
        // console.profileEnd();
        // eslint-disable-next-line no-debugger
        progress.report({ increment: 100 });
        logger.debug(`yaml files loaded, took ${(new Date().getTime() - start.getTime()) / 1000}s`);

        this.onDidLoadRulesheet(this.ruleSheetReloaded.bind(this, progress));

        this.refreshWorkspaceFolderRulesets();

        this.registerFileWatcher();

        // this.loaded = true;
        this.onDidLoadEmitter.emit('didLoad');
    }

    public onDidLoad(listener: () => void) {
        this.onDidLoadEmitter.addListener('didLoad', listener);
    }

    public onDidLoadRulesheet(listener: (file: string, files: number, totalFiles: number) => void) {
        this.onDidLoadEmitter.addListener('didLoadRulesheet', listener);
    }

    public onDidRefresh(listener: () => void) {
        this.onDidRefreshEmitter.addListener('didRefresh', listener);
    }

    public removeOnDidRefresh(listener: () => void) {
        this.onDidRefreshEmitter.removeListener('didRefresh', listener);
    }

    private init(): void {
        logger.debug('init');

        const pattern = workspace.getConfiguration('oxcYamlHelper').get<string>('ruleFilesPattern');
        if (pattern) {
            this.yamlPattern = pattern;
        }
        logger.debug('using pattern', this.yamlPattern);

        rulesetTree.init();
    }

    private ruleSheetLoaded(
        progress: Progress<{ message?: string; increment?: number }>,
        file: string,
        filesLoaded: number,
        totalFiles: number,
    ): void {
        const increment = Math.round((1 / totalFiles) * 100);

        progress.report({
            increment: increment,
            message: `${file} (${filesLoaded}/${totalFiles})`,
        });
    }

    private ruleSheetReloaded(_progress: Progress<{ message?: string; increment?: number }>): void {
        // wait until we are not processing files anymore
        if (Object.keys(this.processingFiles).length > 0 || Object.keys(this.deletingFiles).length > 0) {
            return;
        }

        logger.info(`refreshing workspace folder rulesets`);
        this.refreshWorkspaceFolderRulesets();
        this.onDidRefreshEmitter.emit('didRefresh');
    }

    private async loadYamlFiles() {
        if (!workspace.workspaceFolders) {
            return;
        }

        return Promise.all(
            workspace.workspaceFolders.map(async (workspaceFolder) => {
                const modRoot = this.getModRootUri(workspaceFolder);
                logger.debug('loading yaml files for mod root:', modRoot.fsPath);
                const files = await this.getYamlFilesForWorkspaceFolder(workspaceFolder);
                return Promise.all(
                    files.map((file) => {
                        logger.debug(`loading ruleset file: ${this.getCleanFile(file, modRoot)}`);
                        return this.loadYamlIntoTree(file, workspaceFolder, files.length);
                    }),
                );
            }),
        );
    }

    private async getYamlFilesForWorkspaceFolder(workspaceFolder: WorkspaceFolder): Promise<Uri[]> {
        let files: Uri[] = [];
        const modRoot = this.getModRootUri(workspaceFolder);
        if (!existsSync(modRoot.fsPath)) {
            window.showErrorMessage(
                `Cannot find configured OpenXcom mod root '${workspace.asRelativePath(modRoot)}' for workspace '${workspaceFolder.name}'`,
            );
            return files;
        }

        await Promise.all([
            await workspace.findFiles(new RelativePattern(modRoot.fsPath, this.yamlPattern)),
            await workspace.findFiles(new RelativePattern(modRoot.fsPath, '**/Language/*.yml')),
        ]).then((values) => {
            files = files.concat(...values);
        });

        await this.getAssetRulesets(files);

        // load parent mods into the mix
        files = await this.findParentMods(workspaceFolder, modRoot, files);

        this.rulesetHierarchy.mod = modRoot;

        logger.debug(`Hierarchy: ${JSON.stringify(this.rulesetHierarchy)}`);

        for (const idx in files) {
            if (!files[idx].fsPath) {
                // make sure we get the fs path (we don't get them from the workspace)
                files[idx] = Uri.file(files[idx].path);
            }
        }

        if (files.length === 0) {
            logger.warn(`no ruleset files in mod root found, ${modRoot.path} is probably not an OXC(E) project.`);
            return files;
        }

        return files;
    }

    /**
     * Loads any parent mods if specified in the settings
     * @param workspaceFolder
     * @param modRoot
     * @param files
     * @returns
     */
    private async findParentMods(workspaceFolder: WorkspaceFolder, modRoot: Uri, files: Uri[]) {
        const parentMods = workspace.getConfiguration('oxcYamlHelper', workspaceFolder.uri).get<string[]>('parentMods') || [];
        if (parentMods.length) {
            const missingMods = [];
            for (const parentMod of parentMods) {
                const parentModUri = Uri.joinPath(modRoot, `../${parentMod}`);
                if (existsSync(parentModUri.fsPath)) {
                    logger.debug(`Adding in parent mod ${parentMod}`);
                    this.rulesetHierarchy[`parent${parentMod}`] = parentModUri;

                    const foundFiles = await glob(Uri.joinPath(parentModUri, '**/*.rul').fsPath, {});
                    files = files.concat(...foundFiles.map((path) => Uri.file(path)));
                } else {
                    missingMods.push(parentMod);
                }
            }

            if (missingMods.length) {
                window.showErrorMessage(`Cannot find parent mods paths for '${missingMods.join(', ')}'`);
            }
        }

        return files;
    }

    private async getAssetRulesets(files: Uri[]) {
        const assetPath = this.getAssetUri();
        if (!assetPath) {
            return;
        }
        this.rulesetHierarchy.vanilla = assetPath;

        if (this.context) {
            const assets = await workspace.fs.readDirectory(assetPath);

            for (const [name, type] of assets) {
                if (type === FileType.File) {
                    if (name.endsWith('.rul')) {
                        files.push(Uri.joinPath(assetPath, '/', name));
                    }
                }
            }

            // also load language file(s) from vanilla
            const languageAssets = await workspace.fs.readDirectory(Uri.joinPath(assetPath, '/Language'));

            for (const [name, type] of languageAssets) {
                if (type === FileType.File) {
                    if (name.endsWith('.yml')) {
                        files.push(Uri.joinPath(assetPath, '/Language/', name));
                    }
                }
            }
        }
    }

    private registerFileWatcher(): void {
        if (this.fileSystemWatcher) {
            this.fileSystemWatcher.dispose();
        }

        if (workspace.workspaceFolders?.length === 1) {
            const modRoot = this.getModRootUri(workspace.workspaceFolders[0]);
            this.fileSystemWatcher = workspace.createFileSystemWatcher(
                new RelativePattern(modRoot.fsPath, `{${this.yamlPattern},**/Language/*.yml}`),
            );
        } else {
            this.fileSystemWatcher = workspace.createFileSystemWatcher('**/{' + this.yamlPattern + ',Language/*.yml}');
        }

        this.fileSystemWatcher.onDidDelete((e: Uri) => {
            logger.debug(`file deleted ${e.path}`);
            this.deletingFiles[e.path] = true;
            this.deleteFileFromTree(e);
        });
        this.fileSystemWatcher.onDidCreate(async (e: Uri) => {
            this.loadYamlIntoTree(e);
        });

        this.handleFileChanges(this.fileSystemWatcher);
    }

    private handleFileChanges(watcher: FileSystemWatcher) {
        watcher.onDidChange((e: Uri) => {
            const isSavedFile = e.path in this.savedFiles;
            if (isSavedFile) {
                // saved files don't get a `onDidChangeTextDocument`, so handle it differently
                delete this.savedFiles[e.path];
            } else {
                this.processingFiles[e.path] = true;
            }

            logger.debug(
                `reloading ruleset file: ${e.path} (processing: ${
                    Object.keys(this.processingFiles).length
                }) (deleted: ${Object.keys(this.deletingFiles).length})`,
            );
            if (isSavedFile || !workspace.textDocuments.find((wsFile) => wsFile.fileName === e.fsPath)) {
                this.loadYamlIntoTree(e);
            }
        });

        workspace.onDidSaveTextDocument((e) => {
            this.savedFiles[e.uri.path] = true;
        });

        workspace.onDidChangeTextDocument((e) => {
            // wait for the textdocument to change, before parsing again
            if (!(e.document.uri.path in this.processingFiles)) {
                return;
            }

            logger.debug(`textdoc changed: ${e.document.uri.path}`);
            this.loadYamlIntoTree(e.document.uri);
        });
    }

    private deleteFileFromTree(file: Uri) {
        const workspaceFolder = workspace.getWorkspaceFolder(file);
        if (!workspaceFolder) {
            throw new Error('workspace folder could not be found');
        }

        rulesetTree.deleteFileFromTree(workspaceFolder, file);

        // trigger a reload (should maybe have its own event)?
        delete this.deletingFiles[file.path];
        this.onDidLoadEmitter.emit('didLoadRulesheet');
    }

    private async loadYamlIntoTree(
        file: Uri,
        workspaceFolder?: WorkspaceFolder,
        numberOfFiles?: number,
    ): Promise<void> {
        if (!workspaceFolder) {
            workspaceFolder = workspace.getWorkspaceFolder(file);
        }
        if (!workspaceFolder) {
            throw new Error('workspace folder could not be found');
        }

        let parsed: ParsedRuleset | undefined = await rulesetFileCacheManager.retrieve(file);
        if (parsed) {
            logger.debug(`Retrieved ${file.path} from cache`);
        } else {
            try {
                parsed = await this.parseDocument(file, workspaceFolder);
            } catch (error) {
                window.showErrorMessage(
                    `Failed to parse: ${workspace.asRelativePath(
                        file.path,
                    )}, look for any errors or contact the extension author`,
                    'Dismiss',
                );
            }
        }
        if (!parsed) {
            reporter.sendTelemetryErrorEvent(`Could not parse/retrieve from cache ${file.path}`);
            logger.error(`Could not parse/retrieve from cache ${file.path}`);
            delete this.processingFiles[file.path];
            return;
        }

        if (parsed.definitions) {
            rulesetTree.mergeIntoTree(parsed.definitions, workspaceFolder, file);
        }
        if (parsed.references) {
            rulesetTree.mergeReferencesIntoTree(parsed.references, workspaceFolder, file);
        }
        if (parsed.variables) {
            rulesetTree.mergeVariablesIntoTree(parsed.variables, workspaceFolder, file);
        }
        if (parsed.logicData) {
            rulesetTree.mergeLogicDataIntoTree(parsed.logicData, workspaceFolder, file);
        }

        rulesetTree.mergeTranslationsIntoTree(parsed.translations, workspaceFolder, file);

        const modRoot = this.getModRootUri(workspaceFolder);
        delete this.processingFiles[file.path];
        this.onDidLoadEmitter.emit(
            'didLoadRulesheet',
            this.getCleanFile(file, modRoot),
            rulesetTree.getNumberOfParsedDefinitionFiles(workspaceFolder),
            numberOfFiles,
        );
    }

    private async parseDocument(file: Uri, workspaceFolder: WorkspaceFolder): Promise<ParsedRuleset | undefined> {
        const document = await this.getTextDocument(file);
        if (document.getText().trim().length === 0) {
            // new files could be empty
            return {
                translations: [],
            };
        }

        try {
            const modRoot = this.getModRootUri(workspaceFolder);
            let translations: Translation[] = [];
            let parsed: ParsedRuleset;
            if (this.isLanguageFile(file)) {
                const docObject = parse(document.getText(), { uniqueKeys: false });

                translations = rulesetParser.getTranslationsFromLanguageFile(docObject, this.getLocale());
                parsed = { translations };
            } else {
                const text = document.getText();

                const lines = text.split('\n');
                let anyLines = false;
                for (const line of lines) {
                    const trimmedLine = line.trim();
                    if (trimmedLine !== '' && !trimmedLine.startsWith('#')) {
                        // Found a line that is not a comment or blank
                        anyLines = true;
                        break;
                    }
                }

                if (!anyLines) {
                    // empty file
                    console.debug('Document contains only comments or blank lines. Skipping...');
                    return;
                }

                const doc = rulesetParser.parseDocument(text);

                const [references, logicData] = rulesetParser.getReferencesRecursively(doc.parsed);

                rulesetParser.addRangePositions(references, document);
                rulesetParser.addRangePositions(logicData, document);
                logger.debug(`found ${references?.length} references in file ${this.getCleanFile(file, modRoot)}`);
                logger.debug(
                    `found ${logicData?.length} logic data entries in file ${this.getCleanFile(file, modRoot)}`,
                );
                const definitions = rulesetParser.getDefinitionsFromReferences(references);
                logger.debug(`found ${definitions.length} definitions in file ${this.getCleanFile(file, modRoot)}`);

                // can't use references (yet), variables and extraStrings are not references (yet) (they are keys, not values)
                const variables = rulesetParser.getVariables(references);

                if (references.some((ref) => ref.key === 'extraStrings')) {
                    const docObject = parse(document.getText(), { uniqueKeys: false });
                    translations = rulesetParser.getTranslations(docObject);
                }

                parsed = { definitions, references, variables, translations, logicData };
            }

            // don't need to wait for cache to be written
            /*await */ rulesetFileCacheManager.put(file, parsed);

            return parsed;
        } catch (error: any) {
            reporter.sendTelemetryErrorEvent(error, { 'file.path': file.path } /*, { 'numericMeasure': 123 }*/);
            reporter.sendTelemetryErrorEvent('loadYamlIntoTree', {
                'file.path': file.path,
                'error.message': error.message,
            });
            logger.error('loadYamlIntoTree', file.path, error.message);
            throw error;
        }

        return;
    }

    private isLanguageFile(file: Uri) {
        return file.path.indexOf('Language/') !== -1 && file.path.slice(file.path.lastIndexOf('.')) === '.yml';
    }

    private async getTextDocument(file: Uri) {
        let doc;
        if ((doc = workspace.textDocuments.find((wsFile) => wsFile.fileName === file.path))) {
            // quicker way of getting the text document than opening it
            return doc;
        }

        return await workspace.openTextDocument(file);
    }

    public getTranslationForKey(key: string, sourceUri?: Uri, undefinedIfMissing = false): string | undefined {
        if (!sourceUri) {
            sourceUri = window.activeTextEditor?.document.uri;
        }
        if (!sourceUri) {
            return;
        }

        const folder = workspace.getWorkspaceFolder(sourceUri);
        if (!folder) {
            // file is most likely not in the workspace folder (probably an asset), so ignore it
            throw new FileNotInWorkspaceError();
        }

        const translation = rulesetTree.getTranslation(key, folder);
        if (translation === undefined && undefinedIfMissing) {
            return;
        }

        if (!translation) {
            return `No translation found for locale '${this.getLocale()}' '${key}'!`;
        }

        return translation;
    }

    public refreshWorkspaceFolderRulesets() {
        if (!workspace.workspaceFolders || !this.context) {
            return;
        }

        workspace.workspaceFolders.map((workspaceFolder) => {
            rulesetTree.refresh(workspaceFolder);
        });

        const start = new Date();
        this.validateReferences();
        logger.debug(`rulesets validated, took ${(new Date().getTime() - start.getTime()) / 1000}s`);
    }

    private validateReferences() {
        if (!workspace.workspaceFolders || !this.context) {
            return;
        }

        workspace.workspaceFolders.map((workspaceFolder) => {
            rulesetTree.checkDefinitions(workspaceFolder, this.getAssetUri() ?? Uri.file('__NO_OXC_ASSETS__'));
        });

        this.checkForCommonProblems();

        this.loaded = true;
    }

    private checkForCommonProblems() {
        const problemsByPath = rulesetDefinitionChecker.getProblemsByPath();
        const itemsCategories = problemsByPath['items.categories'] || 0;

        if (itemsCategories > 25) {
            this.proposeDisableCategories();
        }
    }

    private proposeDisableCategories() {
        if (workspace.getConfiguration('oxcYamlHelper').get<string>('validateCategories') !== 'yes') {
            return;
        }

        const message =
            'There are many missing category references in these rulesets. Would you like to ignore these from now on?';

        const choices = {
            yes: 'Yes',
            notNow: 'Not now',
            always: "No and don't ask again",
        };

        window.showInformationMessage(message, ...Object.values(choices)).then((result) => {
            if (result === choices.yes) {
                workspace
                    .getConfiguration('oxcYamlHelper')
                    .update('validateCategories', 'no', ConfigurationTarget.Workspace);
            } else if (result === choices.always) {
                workspace
                    .getConfiguration('oxcYamlHelper')
                    .update('validateCategories', 'always', ConfigurationTarget.Workspace);
            }
        });
    }

    private getAssetUri(): Uri | undefined {
        if (!this.context) {
            throw new Error("Couldn't get extension context");
        }

        const baseGame = workspace.getConfiguration('oxcYamlHelper').get<string>('baseGame');
        if (baseGame === 'none') {
            return;
        }

        const game = `xcom1${baseGame === 'oxce' ? '-oxce' : ''}`;

        let path = `out/assets/${game}`;
        if (existsSync(Uri.joinPath(this.context.extensionUri, `/src/assets/${game}`).fsPath)) {
            path = `src/assets/${game}`;
        }

        return Uri.joinPath(this.context.extensionUri, '/' + path);
    }

    private getModRootUri(workspaceFolder: WorkspaceFolder): Uri {
        const configuredModRoot = workspace
            .getConfiguration('oxcYamlHelper', workspaceFolder.uri)
            .get<string>('modRoot')
            ?.trim();
        if (!configuredModRoot || configuredModRoot === '.') {
            return workspaceFolder.uri;
        }

        const pathParts = configuredModRoot
            .replace(/\\/g, '/')
            .split('/')
            .filter((pathPart) => pathPart.length > 0 && pathPart !== '.');

        if (pathParts.length === 0) {
            return workspaceFolder.uri;
        }

        return Uri.joinPath(workspaceFolder.uri, ...pathParts);
    }

    public getRulesetHierarchy() {
        return this.rulesetHierarchy;
    }

    public getCleanFile(file: Uri, workspaceFolder: Uri) {
        const assetPath = this.getAssetUri();
        let fileClean = '';
        if (assetPath && file.path.startsWith(assetPath.path)) {
            fileClean = `<ASSETS>/${file.path.slice(assetPath.path.length + 1)}`;
        } else if (file.path.startsWith(Uri.joinPath(workspaceFolder, '/').path)) {
            fileClean = file.path.slice(workspaceFolder.path.length + 1);
        } else {
            fileClean = file.fsPath;
        }

        return fileClean;
    }

    public getLocale(): string {
        return workspace.getConfiguration('oxcYamlHelper').get<string>('translationLocale') ?? 'en-US';
    }

    public dispose() {
        if (this.fileSystemWatcher) {
            this.fileSystemWatcher.dispose();
        }
    }
}
