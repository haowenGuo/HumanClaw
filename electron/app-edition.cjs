const fs = require('fs');
const path = require('path');
const { normalizeBuildEdition } = require('./edition-manifest.cjs');

function resolvePackageMetadata(app) {
    if (!app || typeof app.getAppPath !== 'function') {
        return {};
    }

    try {
        const packageJsonPath = path.join(app.getAppPath(), 'package.json');
        if (!fs.existsSync(packageJsonPath)) {
            return {};
        }
        return JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    } catch {
        return {};
    }
}

function getBundledInstallEdition(app) {
    const envEdition = process.env.HUMANCLAW_INSTALL_EDITION || process.env.HUMANCLAW_BUILD_EDITION;
    if (envEdition) {
        return normalizeBuildEdition(envEdition);
    }

    const packageMetadata = resolvePackageMetadata(app);
    if (packageMetadata?.humanclawEdition) {
        return normalizeBuildEdition(packageMetadata.humanclawEdition);
    }

    return 'assistant';
}

module.exports = {
    getBundledInstallEdition
};
