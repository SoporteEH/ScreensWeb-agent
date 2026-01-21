const { app } = require('electron');
const si = require('systeminformation');
const { log } = require('../utils/logConfig');

let cachedStatus = null;
let lastCheckTime = 0;
const CACHE_DURATION_MS = 5 * 60 * 1000;

async function getGpuStatus(arg = {}) {
    try {
        const force = (typeof arg === 'boolean') ? arg : (arg && arg.force === true);
        const now = Date.now();
        
        if (!force && cachedStatus && (now - lastCheckTime < CACHE_DURATION_MS)) {
            return cachedStatus;
        }

        log.info('[GPU_CHECK]: Ejecutando diagnostico de hardware...');
        
        const graphics = await si.graphics();
        const gpuInfo = await app.getGPUInfo('complete');
        
        const activeElectronGpu = gpuInfo.gpuDevice?.[0]?.deviceString || 'Desconocida';

        const controllers = graphics.controllers || [];
        
        const dedicatedGpu = controllers.find(c => 
            (c.vendor.toLowerCase().includes('nvidia') || 
             c.vendor.toLowerCase().includes('amd') || 
             c.vendor.toLowerCase().includes('advanced micro devices')) &&
            !c.model.toLowerCase().includes('graphics')
        );

        const hasDedicatedAvailable = !!dedicatedGpu;

        const usingDedicated = dedicatedGpu && activeElectronGpu.toLowerCase().includes(dedicatedGpu.model.toLowerCase().split(' ')[0].toLowerCase());
        
        const isOptimal = hasDedicatedAvailable ? usingDedicated : true;

        let connectionType = "Placa Base (Integrada)";
        if (hasDedicatedAvailable && usingDedicated) {
            connectionType = "Gráfica Dedicada";
        } else if (!hasDedicatedAvailable) {
            connectionType = "Integrada (Única disponible)";
        }

        cachedStatus = {
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
        lastCheckTime = now;

        return cachedStatus;

    } catch (error) {
        log.error('[GPU_CHECK]: Error al diagnosticar hardware:', error);
        return {
            gpuName: 'Error diagnóstico',
            connectionType: 'Desconocido',
            isOptimal: false,
            electronRenderer: 'Error'
        };
    }
}

module.exports = { getGpuStatus };