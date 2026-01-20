const { app } = require('electron');
const si = require('systeminformation');
const { log } = require('../utils/logConfig');

/**
 * Checks if the monitor is connected to the dedicated GPU instead of integrated graphics.
 */
async function getGpuStatus() {
    try {
        const graphics = await si.graphics();
        const gpuInfo = await app.getGPUInfo('complete');
        const activeElectronGpu = gpuInfo.gpuDevice[0]?.deviceString || 'Desconocida';

        const controllers = graphics.controllers;

        // Identify Nvidia/AMD dedicated cards
        const dedicatedGpu = controllers.find(c =>
            (c.vendor.toLowerCase().includes('nvidia') ||
                c.vendor.toLowerCase().includes('amd')) &&
            !c.model.toLowerCase().includes('graphics')
        );

        const hasDedicatedAvailable = !!dedicatedGpu;
        const usingDedicated = dedicatedGpu && activeElectronGpu.toLowerCase().includes(dedicatedGpu.model.toLowerCase());

        // If there is a dedicated card, we SHOULD be using it.
        const isOptimal = hasDedicatedAvailable ? usingDedicated : true;

        let connectionType = "Placa Base (Integrada)";
        if (hasDedicatedAvailable && usingDedicated) {
            connectionType = "Grafica Dedicada";
        } else if (!hasDedicatedAvailable) {
            connectionType = "Integrada (Unica disponible)";
        }

        return {
            gpuName: activeElectronGpu,
            connectionType: connectionType,
            isOptimal: !!isOptimal,
            electronRenderer: activeElectronGpu,
            hasDedicatedAvailable,
            details: {
                controllers: controllers.map(c => ({ model: c.model, vram: c.vram, vendor: c.vendor })),
                displays: graphics.displays.length
            }
        };
    } catch (error) {
        log.error('[GPU_CHECK]: Error al diagnosticar hardware:', error);
        return {
            gpuName: 'Error en diagnostico',
            connectionType: 'Desconocido',
            isOptimal: false,
            electronRenderer: 'Error'
        };
    }
}

module.exports = { getGpuStatus };
