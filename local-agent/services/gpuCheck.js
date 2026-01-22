const { app } = require('electron');
const si = require('systeminformation');
const { log } = require('../utils/logConfig');

let cachedStatus = null;
let lastCheckTime = 0;
const CACHE_DURATION_MS = 30 * 60 * 1000;

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
        const systemInfo = await si.system();

        const activeElectronGpu = gpuInfo.gpuDevice?.[0]?.deviceString || 'Desconocida';

        const controllers = graphics.controllers || [];

        log.info('[GPU_CHECK]: GPUs detectadas:', controllers.map(c => `${c.vendor} - ${c.model}`));
        log.info('[GPU_CHECK]: GPU activa en Electron:', activeElectronGpu);
        log.info('[GPU_CHECK]: Tipo de sistema:', systemInfo.model || 'Desktop');

        const isLaptop = systemInfo.model && (
            systemInfo.model.toLowerCase().includes('laptop') ||
            systemInfo.model.toLowerCase().includes('notebook') ||
            systemInfo.chassis === 'Notebook' ||
            systemInfo.chassis === 'Laptop' ||
            systemInfo.chassis === 'Portable'
        );

        // Detectar GPUs dedicadas (NVIDIA, AMD)
        const dedicatedGpu = controllers.find(c => {
            const vendor = c.vendor.toLowerCase();
            const model = c.model.toLowerCase();

            // NVIDIA dedicadas (GeForce, Quadro, Tesla, RTX, GTX)
            if (vendor.includes('nvidia') &&
                (model.includes('geforce') || model.includes('quadro') ||
                    model.includes('tesla') || model.includes('rtx') || model.includes('gtx'))) {
                return true;
            }

            // AMD dedicadas (Radeon RX, Pro, Vega, etc)
            if ((vendor.includes('amd') || vendor.includes('advanced micro devices')) &&
                (model.includes('radeon') || model.includes('rx') ||
                    model.includes('vega') || model.includes('pro'))) {
                return true;
            }

            return false;
        });

        const hasDedicatedAvailable = !!dedicatedGpu;

        // Verificar si se está usando la GPU dedicada
        let usingDedicated = false;
        if (dedicatedGpu) {
            const dedicatedModelParts = dedicatedGpu.model.toLowerCase().split(' ');
            const activeGpuLower = activeElectronGpu.toLowerCase();

            usingDedicated = dedicatedModelParts.some(part =>
                part.length > 3 && activeGpuLower.includes(part)
            );
        }

        let isOptimal = true;
        if (!isLaptop && hasDedicatedAvailable && !usingDedicated) {
            isOptimal = false;
        }

        let connectionType = "Integrada";
        let warningMessage = null;

        if (hasDedicatedAvailable && usingDedicated) {
            connectionType = "Gráfica Dedicada";
        } else if (!hasDedicatedAvailable) {
            connectionType = "Única disponible";
        } else if (hasDedicatedAvailable && !usingDedicated && isLaptop) {
            connectionType = "Integrada (Optimus)";
            warningMessage = `ℹ️ Laptop con GPU híbrida (Optimus)\n\nGPU integrada: ${activeElectronGpu}\nGPU dedicada: ${dedicatedGpu.vendor} ${dedicatedGpu.model}\n\nWindows cambiará a la GPU dedicada automáticamente si es necesario.\n\n💡 Para 1-2 pantallas, la GPU integrada es suficiente.`;
        } else if (hasDedicatedAvailable && !usingDedicated && !isLaptop) {
            connectionType = "⚠️ GPU Integrada";
            warningMessage = `Monitor conectado a GPU integrada.\n\nGPU dedicada disponible: ${dedicatedGpu.vendor} ${dedicatedGpu.model}\n\nConecta el monitor a la GPU dedicada para mejor rendimiento en multi-pantalla.`;
        }

        log.info(`[GPU_CHECK]: Resultado - Laptop: ${isLaptop}, Optimal: ${isOptimal}, Tipo: ${connectionType}`);

        cachedStatus = {
            gpuName: activeElectronGpu,
            connectionType: connectionType,
            isOptimal: !!isOptimal,
            isLaptop: isLaptop,
            electronRenderer: activeElectronGpu,
            hasDedicatedAvailable,
            dedicatedGpuName: dedicatedGpu ? `${dedicatedGpu.vendor} ${dedicatedGpu.model}` : null,
            warningMessage: warningMessage,
            details: {
                controllers: controllers.map(c => ({ model: c.model, vram: c.vram, vendor: c.vendor })),
                displays: graphics.displays.length,
                systemType: isLaptop ? 'Laptop' : 'Desktop'
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