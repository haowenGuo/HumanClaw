module.exports = {
    appId: 'com.openclaw.runtime',
    productName: 'OpenClaw Runtime',
    compression: 'normal',
    directories: {
        output: 'release/openclaw-runtime'
    },
    files: [
        'openclaw-installer/**/*',
        'electron/openclaw-gateway.cjs',
        'electron/fs-layout.cjs',
        'electron/edition-manifest.cjs',
        'package.json'
    ],
    extraMetadata: {
        main: 'openclaw-installer/main.cjs',
        description: 'Bundled OpenClaw local runtime installer and gateway launcher.'
    },
    extraResources: [
        {
            from: 'build-cache/openclaw-runtime',
            to: 'openclaw-runtime',
            filter: ['**/*', '!node_modules/**/*']
        },
        {
            from: 'build-cache/openclaw-runtime/node_modules',
            to: 'openclaw-runtime-node-modules',
            filter: ['**/*']
        },
        {
            from: 'build-cache/openclaw-vendor',
            to: 'openclaw-vendor',
            filter: ['**/*']
        }
    ],
    asar: true,
    npmRebuild: false,
    win: {
        executableName: 'OpenClaw-Runtime',
        signAndEditExecutable: false,
        target: [
            {
                target: 'nsis',
                arch: ['x64']
            },
            {
                target: 'portable',
                arch: ['x64']
            }
        ]
    },
    nsis: {
        artifactName: 'OpenClaw-Runtime-Setup-${version}-win-${arch}.${ext}',
        oneClick: false,
        allowToChangeInstallationDirectory: true,
        createDesktopShortcut: true,
        createStartMenuShortcut: true,
        runAfterFinish: true
    },
    portable: {
        artifactName: 'OpenClaw-Runtime-Portable-${version}-win-${arch}.${ext}'
    }
};
