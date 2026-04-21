const path = require('path');

const INSTALL_EDITIONS = ['companion', 'assistant', 'operator'];

const EDITION_DEFINITIONS = {
    companion: {
        id: 'companion',
        label: '桌宠版',
        productName: 'HumanClaw Companion',
        executableName: 'HumanClaw-Companion',
        artifactBaseName: 'HumanClaw-Companion',
        appId: 'com.humanclaw.desktop.companion',
        outputDir: path.join('release', 'companion'),
        description: 'Companion-focused desktop pet build with lightweight local chat experience.'
    },
    assistant: {
        id: 'assistant',
        label: '助手版',
        productName: 'HumanClaw Assistant',
        executableName: 'HumanClaw-Assistant',
        artifactBaseName: 'HumanClaw-Assistant',
        appId: 'com.humanclaw.desktop.assistant',
        outputDir: path.join('release', 'assistant'),
        description: 'Balanced desktop pet build with OpenClaw assistant integration.'
    },
    operator: {
        id: 'operator',
        label: '完全控制版',
        productName: 'HumanClaw Operator',
        executableName: 'HumanClaw-Operator',
        artifactBaseName: 'HumanClaw-Operator',
        appId: 'com.humanclaw.desktop.operator',
        outputDir: path.join('release', 'operator'),
        description: 'Advanced desktop pet build with broader local automation boundaries.'
    }
};

function normalizeBuildEdition(value) {
    if (typeof value !== 'string') {
        return 'assistant';
    }

    const normalized = value.trim().toLowerCase();
    return INSTALL_EDITIONS.includes(normalized) ? normalized : 'assistant';
}

function resolveBuildEditionMetadata(value) {
    const edition = normalizeBuildEdition(value);
    return EDITION_DEFINITIONS[edition];
}

module.exports = {
    INSTALL_EDITIONS,
    EDITION_DEFINITIONS,
    normalizeBuildEdition,
    resolveBuildEditionMetadata
};
