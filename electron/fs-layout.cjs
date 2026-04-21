const fs = require('fs');
const path = require('path');
const { normalizeBuildEdition, resolveBuildEditionMetadata } = require('./edition-manifest.cjs');

const DEFAULT_ROOT_DRIVE = 'F:';
const DEFAULT_WORKSPACE_DIR_NAME = 'HumanClaw';

function normalizeOptionalString(value, fallback = '') {
    if (typeof value !== 'string') {
        return fallback;
    }

    const trimmed = value.trim();
    return trimmed || fallback;
}

function extractWindowsDriveRoot(value) {
    const normalized = normalizeOptionalString(value).replace(/\//g, '\\');
    const match = /^([a-zA-Z]):(?:\\|$)/.exec(normalized);
    return match ? `${match[1].toUpperCase()}:` : '';
}

function resolveDefaultRootDrive(options = {}) {
    return (
        extractWindowsDriveRoot(options.drive) ||
        extractWindowsDriveRoot(options.workspaceRoot) ||
        extractWindowsDriveRoot(options.installRoot) ||
        extractWindowsDriveRoot(options.runtimeRoot) ||
        extractWindowsDriveRoot(options.appPath) ||
        extractWindowsDriveRoot(process.env.HUMANCLAW_ROOT_DRIVE) ||
        extractWindowsDriveRoot(process.env.HUMANCLAW_WORKSPACE_ROOT) ||
        extractWindowsDriveRoot(process.env.HUMANCLAW_INSTALL_ROOT) ||
        extractWindowsDriveRoot(process.env.HUMANCLAW_DATA_ROOT) ||
        extractWindowsDriveRoot(process.execPath) ||
        extractWindowsDriveRoot(process.cwd()) ||
        DEFAULT_ROOT_DRIVE
    );
}

function normalizeWindowsDriveRoot(value, fallback = DEFAULT_ROOT_DRIVE) {
    return extractWindowsDriveRoot(value) || extractWindowsDriveRoot(fallback) || DEFAULT_ROOT_DRIVE;
}

function joinFromDrive(drive, ...segments) {
    return path.win32.join(`${normalizeWindowsDriveRoot(drive)}\\`, ...segments);
}

function sanitizePathSegment(value, fallback = 'HumanClaw') {
    const normalized = normalizeOptionalString(value, fallback)
        .replace(/[<>:"/\\|?*\x00-\x1f]+/g, '-')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '');

    return normalized || fallback;
}

function dedupeStrings(values) {
    const seen = new Set();
    const result = [];
    for (const value of values) {
        const normalized = normalizeOptionalString(value);
        if (!normalized || seen.has(normalized)) {
            continue;
        }
        seen.add(normalized);
        result.push(normalized);
    }
    return result;
}

function dedupeHomeHints(hints) {
    const seen = new Set();
    const result = [];
    for (const hint of hints) {
        const home = normalizeOptionalString(hint?.home);
        if (!home || seen.has(home)) {
            continue;
        }
        seen.add(home);
        result.push({
            home,
            preferNested: Boolean(hint?.preferNested)
        });
    }
    return result;
}

function resolveWindowsAppDataPath(...segments) {
    const appData = normalizeOptionalString(process.env.APPDATA);
    if (!appData) {
        return '';
    }
    return path.win32.join(appData, ...segments);
}

function resolveInstallEdition(options = {}) {
    return normalizeBuildEdition(
        options.installEdition ||
        options.buildEdition ||
        process.env.HUMANCLAW_INSTALL_EDITION ||
        process.env.HUMANCLAW_BUILD_EDITION ||
        'assistant'
    );
}

function resolveHumanClawFsLayout(options = {}) {
    const edition = resolveInstallEdition(options);
    const editionMeta = resolveBuildEditionMetadata(edition);
    const drive = normalizeWindowsDriveRoot(
        options.drive || process.env.HUMANCLAW_ROOT_DRIVE,
        resolveDefaultRootDrive(options)
    );
    const workspaceRoot =
        normalizeOptionalString(options.workspaceRoot || process.env.HUMANCLAW_WORKSPACE_ROOT) ||
        joinFromDrive(drive, DEFAULT_WORKSPACE_DIR_NAME);
    const installRoot =
        normalizeOptionalString(options.installRoot || process.env.HUMANCLAW_INSTALL_ROOT) ||
        path.win32.join(workspaceRoot, 'Applications');
    const runtimeRoot =
        normalizeOptionalString(options.runtimeRoot || process.env.HUMANCLAW_DATA_ROOT) ||
        path.win32.join(workspaceRoot, 'Runtime');
    const vmRoot =
        normalizeOptionalString(options.vmRoot || process.env.HUMANCLAW_VM_ROOT) ||
        path.win32.join(workspaceRoot, 'VM');
    const builderRoot =
        normalizeOptionalString(options.builderRoot || process.env.HUMANCLAW_BUILD_ROOT) ||
        path.win32.join(workspaceRoot, 'Build');
    const appDirName = sanitizePathSegment(
        editionMeta.executableName || editionMeta.productName || editionMeta.appId || 'HumanClaw'
    );
    const appDataRoot = path.win32.join(runtimeRoot, appDirName);
    const mlCacheRoot = path.win32.join(appDataRoot, 'ml-cache');
    const sharedOpenClawHomeDir =
        normalizeOptionalString(options.sharedOpenClawHomeDir || process.env.HUMANCLAW_OPENCLAW_HOME) ||
        path.win32.join(runtimeRoot, 'OpenClawHome');

    return {
        drive,
        edition,
        editionMeta,
        workspaceRoot,
        installRoot,
        installDir: path.win32.join(installRoot, appDirName),
        runtimeRoot,
        appDataRoot,
        userDataDir: path.win32.join(appDataRoot, 'user-data'),
        sessionDataDir: path.win32.join(appDataRoot, 'session-data'),
        logsDir: path.win32.join(appDataRoot, 'logs'),
        tempDir: path.win32.join(appDataRoot, 'temp'),
        cacheDir: path.win32.join(appDataRoot, 'cache'),
        crashDumpsDir: path.win32.join(appDataRoot, 'crash-dumps'),
        sttTempDir: path.win32.join(appDataRoot, 'stt-temp'),
        mlCacheRoot,
        modelScopeCacheDir: path.win32.join(mlCacheRoot, 'modelscope'),
        huggingFaceHomeDir: path.win32.join(mlCacheRoot, 'huggingface'),
        transformersCacheDir: path.win32.join(mlCacheRoot, 'huggingface', 'transformers'),
        torchCacheDir: path.win32.join(mlCacheRoot, 'torch'),
        sharedOpenClawHomeDir,
        sharedOpenClawConfigDir: path.win32.join(sharedOpenClawHomeDir, '.openclaw'),
        sharedOpenClawLogsDir: path.win32.join(sharedOpenClawHomeDir, 'logs'),
        openClawRepoRoot:
            normalizeOptionalString(options.openClawRepoRoot || process.env.HUMANCLAW_OPENCLAW_REPO_ROOT) ||
            path.win32.join(workspaceRoot, 'OPENCLAW_Lobster'),
        vmRoot,
        virtualBoxHomeDir: path.win32.join(vmRoot, 'VirtualBoxHome'),
        virtualBoxMachinesDir: path.win32.join(vmRoot, 'VirtualBoxVMs'),
        virtualBoxIsoDir: path.win32.join(vmRoot, 'ISO'),
        virtualBoxLogsDir: path.win32.join(vmRoot, 'logs'),
        qemuRootDir: path.win32.join(vmRoot, 'QEMU'),
        builderRoot,
        builderCacheDir: path.win32.join(builderRoot, 'cache'),
        builderTempDir: path.win32.join(builderRoot, 'temp'),
        electronBuilderCacheDir: path.win32.join(builderRoot, 'cache', 'electron-builder'),
        pnpmCacheDir: path.win32.join(builderRoot, 'cache', 'pnpm'),
        yarnCacheDir: path.win32.join(builderRoot, 'cache', 'yarn'),
        pnpmStoreDir: path.win32.join(builderRoot, 'cache', 'pnpm-store')
    };
}

const DEFAULT_LAYOUT_DIR_KEYS = [
    'workspaceRoot',
    'installRoot',
    'runtimeRoot',
    'appDataRoot',
    'userDataDir',
    'sessionDataDir',
    'logsDir',
    'tempDir',
    'cacheDir',
    'crashDumpsDir',
    'sttTempDir',
    'mlCacheRoot',
    'modelScopeCacheDir',
    'huggingFaceHomeDir',
    'transformersCacheDir',
    'torchCacheDir',
    'sharedOpenClawHomeDir',
    'sharedOpenClawConfigDir',
    'sharedOpenClawLogsDir',
    'vmRoot',
    'virtualBoxHomeDir',
    'virtualBoxMachinesDir',
    'virtualBoxIsoDir',
    'virtualBoxLogsDir',
    'qemuRootDir',
    'builderRoot',
    'builderCacheDir',
    'builderTempDir',
    'electronBuilderCacheDir',
    'pnpmCacheDir',
    'yarnCacheDir',
    'pnpmStoreDir'
];

const BUILD_LAYOUT_DIR_KEYS = [
    'workspaceRoot',
    'installRoot',
    'runtimeRoot',
    'vmRoot',
    'virtualBoxHomeDir',
    'virtualBoxMachinesDir',
    'virtualBoxIsoDir',
    'virtualBoxLogsDir',
    'qemuRootDir',
    'builderRoot',
    'builderCacheDir',
    'builderTempDir',
    'electronBuilderCacheDir',
    'pnpmCacheDir',
    'yarnCacheDir',
    'pnpmStoreDir'
];

function ensureDirectory(targetPath) {
    fs.mkdirSync(targetPath, { recursive: true });
    return targetPath;
}

function ensureHumanClawFsLayout(layout, keys = DEFAULT_LAYOUT_DIR_KEYS) {
    for (const key of keys) {
        const targetPath = layout?.[key];
        if (typeof targetPath === 'string' && targetPath) {
            ensureDirectory(targetPath);
        }
    }
    return layout;
}

function mergeEnvironment(envPatch) {
    for (const [key, value] of Object.entries(envPatch)) {
        if (typeof value === 'string' && value) {
            process.env[key] = value;
        }
    }
    return envPatch;
}

function buildRuntimeEnvironment(layout) {
    return {
        HUMANCLAW_ROOT_DRIVE: layout.drive,
        HUMANCLAW_WORKSPACE_ROOT: layout.workspaceRoot,
        HUMANCLAW_INSTALL_ROOT: layout.installRoot,
        HUMANCLAW_APP_INSTALL_DIR: layout.installDir,
        HUMANCLAW_DATA_ROOT: layout.runtimeRoot,
        HUMANCLAW_APP_DATA_ROOT: layout.appDataRoot,
        HUMANCLAW_USER_DATA_DIR: layout.userDataDir,
        HUMANCLAW_SESSION_DATA_DIR: layout.sessionDataDir,
        HUMANCLAW_LOGS_DIR: layout.logsDir,
        HUMANCLAW_TEMP_DIR: layout.tempDir,
        HUMANCLAW_CACHE_DIR: layout.cacheDir,
        HUMANCLAW_CRASH_DUMPS_DIR: layout.crashDumpsDir,
        HUMANCLAW_STT_TEMP_DIR: layout.sttTempDir,
        HUMANCLAW_VM_ROOT: layout.vmRoot,
        HUMANCLAW_VM_VIRTUALBOX_HOME: layout.virtualBoxHomeDir,
        HUMANCLAW_VM_VIRTUALBOX_VMS: layout.virtualBoxMachinesDir,
        HUMANCLAW_VM_QEMU_ROOT: layout.qemuRootDir,
        HUMANCLAW_OPENCLAW_HOME: layout.sharedOpenClawHomeDir,
        HUMANCLAW_OPENCLAW_CONFIG_DIR: layout.sharedOpenClawConfigDir,
        HUMANCLAW_OPENCLAW_REPO_ROOT: layout.openClawRepoRoot,
        VBOX_USER_HOME: layout.virtualBoxHomeDir,
        HF_HOME: layout.huggingFaceHomeDir,
        HUGGINGFACE_HUB_CACHE: path.win32.join(layout.huggingFaceHomeDir, 'hub'),
        TRANSFORMERS_CACHE: layout.transformersCacheDir,
        MODELSCOPE_CACHE: layout.modelScopeCacheDir,
        TORCH_HOME: layout.torchCacheDir,
        XDG_CACHE_HOME: layout.mlCacheRoot,
        TEMP: layout.tempDir,
        TMP: layout.tempDir,
        TMPDIR: layout.tempDir
    };
}

function buildPackagingEnvironment(layout) {
    return {
        HUMANCLAW_ROOT_DRIVE: layout.drive,
        HUMANCLAW_WORKSPACE_ROOT: layout.workspaceRoot,
        HUMANCLAW_INSTALL_ROOT: layout.installRoot,
        HUMANCLAW_DATA_ROOT: layout.runtimeRoot,
        HUMANCLAW_VM_ROOT: layout.vmRoot,
        HUMANCLAW_OPENCLAW_HOME: layout.sharedOpenClawHomeDir,
        HUMANCLAW_OPENCLAW_REPO_ROOT: layout.openClawRepoRoot,
        VBOX_USER_HOME: layout.virtualBoxHomeDir,
        ELECTRON_BUILDER_CACHE: layout.electronBuilderCacheDir,
        npm_config_cache: layout.pnpmCacheDir,
        npm_config_tmp: layout.builderTempDir,
        YARN_CACHE_FOLDER: layout.yarnCacheDir,
        PNPM_STORE_DIR: layout.pnpmStoreDir,
        TEMP: layout.builderTempDir,
        TMP: layout.builderTempDir,
        TMPDIR: layout.builderTempDir
    };
}

function applyRuntimeEnvironment(layout) {
    return mergeEnvironment(buildRuntimeEnvironment(layout));
}

function applyPackagingEnvironment(layout) {
    return mergeEnvironment(buildPackagingEnvironment(layout));
}

function resolveOpenClawHomeHints(options = {}) {
    const layout = options.layout || resolveHumanClawFsLayout(options);

    return dedupeHomeHints([
        {
            home: normalizeOptionalString(options.managedHomeRoot),
            preferNested: true
        },
        {
            home: normalizeOptionalString(process.env.HUMANCLAW_OPENCLAW_HOME),
            preferNested: true
        },
        {
            home: normalizeOptionalString(process.env.AIGRIL_OPENCLAW_HOME),
            preferNested: false
        },
        {
            home: normalizeOptionalString(process.env.OPENCLAW_HOME),
            preferNested: false
        },
        {
            home: resolveWindowsAppDataPath('OpenClaw Runtime', 'openclaw-home'),
            preferNested: true
        },
        {
            home: layout.sharedOpenClawHomeDir,
            preferNested: true
        },
        {
            home: path.win32.join(layout.workspaceRoot, '.openclaw-source-dev'),
            preferNested: false
        },
        {
            home: path.win32.join(layout.workspaceRoot, '.openclaw'),
            preferNested: false
        }
    ]);
}

function resolveOpenClawRepoHints(options = {}) {
    const layout = options.layout || resolveHumanClawFsLayout(options);
    const appPath = normalizeOptionalString(options.appPath, process.cwd());

    return dedupeStrings([
        normalizeOptionalString(options.bundleRoot),
        normalizeOptionalString(process.env.HUMANCLAW_OPENCLAW_REPO),
        normalizeOptionalString(process.env.AIGRIL_OPENCLAW_REPO),
        normalizeOptionalString(process.env.OPENCLAW_REPO),
        resolveWindowsAppDataPath('OpenClaw Runtime', 'runtime-bundle'),
        layout.openClawRepoRoot,
        path.win32.resolve(appPath, '..', 'OPENCLAW_Lobster'),
        path.win32.resolve(appPath, '..', '..', 'OPENCLAW_Lobster')
    ]);
}

module.exports = {
    BUILD_LAYOUT_DIR_KEYS,
    DEFAULT_LAYOUT_DIR_KEYS,
    applyPackagingEnvironment,
    applyRuntimeEnvironment,
    buildPackagingEnvironment,
    buildRuntimeEnvironment,
    ensureDirectory,
    ensureHumanClawFsLayout,
    normalizeOptionalString,
    resolveHumanClawFsLayout,
    resolveOpenClawHomeHints,
    resolveOpenClawRepoHints
};
