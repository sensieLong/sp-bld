// Set up PDF.js Global Worker
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// Local Application Memory State
const state = {
    files: [], // Struct: { name: string, originalCanvas: HTMLCanvasElement }
    bleedValue: 0.125,
    bleedUnit: 'in', // Default to inches
    dpi: 300,
    showGuides: true
};

// DOM Element Cache References
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const workspace = document.getElementById('workspace');
const previewContainer = document.getElementById('previewContainer');
const bleedUnit = document.getElementById('bleedUnit');
const bleedValue = document.getElementById('bleedValue');
const dpiInput = document.getElementById('dpiInput');
const dpiGroup = document.getElementById('dpiGroup');
const toggleGuides = document.getElementById('toggleGuides');
const btnExportPDF = document.getElementById('btnExportPDF');
const btnExportZIP = document.getElementById('btnExportZIP');
const btnClear = document.getElementById('btnClear');
const loadingScreen = document.getElementById('loadingScreen');
const loadingText = document.getElementById('loadingText');
const loadingSubtext = document.getElementById('loadingSubtext');

// --- Event Listeners Matrix ---
dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', handleDrop);
fileInput.addEventListener('change', handleFileSelect);

bleedUnit.addEventListener('change', (e) => {
    state.bleedUnit = e.target.value;
    if (state.bleedUnit === 'px') {
        dpiGroup.style.display = 'none';
        bleedValue.value = '35';
        bleedValue.step = '1';
    } else if (state.bleedUnit === 'in') {
        dpiGroup.style.display = 'block';
        bleedValue.value = '0.125';
        bleedValue.step = '0.01';
    } else { // mm
        dpiGroup.style.display = 'block';
        bleedValue.value = '3';
        bleedValue.step = '0.1';
    }
    state.bleedValue = parseFloat(bleedValue.value);
    recalculateAndRender();
});

bleedValue.addEventListener('input', (e) => { state.bleedValue = parseFloat(e.target.value) || 0; recalculateAndRender(); });
dpiInput.addEventListener('input', (e) => { state.dpi = parseInt(e.target.value) || 300; recalculateAndRender(); });
toggleGuides.addEventListener('change', (e) => { state.showGuides = e.target.checked; toggleGuideVisibility(); });
btnClear.addEventListener('click', resetApplicationState);
btnExportPDF.addEventListener('click', exportDocumentAsPDF);
btnExportZIP.addEventListener('click', exportSlicesAsZIP);

// --- Processing Pipelines ---
function showLoading(headline, subtitle = "Engaging memory matrix channel allocation...") { 
    loadingText.textContent = headline.toUpperCase(); 
    loadingSubtext.textContent = subtitle;
    loadingScreen.style.display = 'flex'; 
}
function hideLoading() { loadingScreen.style.display = 'none'; }

function handleDrop(e) {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    processFiles(e.dataTransfer.files);
}

function handleFileSelect(e) {
    processFiles(e.target.files);
}

async function processFiles(fileList) {
    if (fileList.length === 0) return;
    showLoading("Ingesting Assets", "Mapping local raw file data blocks into active memory...");

    for (const file of fileList) {
        try {
            if (file.type.startsWith('image/')) {
                const canvas = await renderImageToCanvas(file);
                state.files.push({ name: file.name, originalCanvas: canvas });
            } else if (file.type === 'application/pdf') {
                const canvases = await renderPdfToCanvases(file);
                canvases.forEach((canvas, idx) => {
                    state.files.push({ name: `${file.name} (Page ${idx + 1})`, originalCanvas: canvas });
                });
            }
        } catch (err) {
            console.error("Pipeline failure on asset processing: ", err);
            alert(`Error parsing file ${file.name}: ${err.message}`);
        }
    }

    hideLoading();
    if (state.files.length > 0) {
        dropZone.style.display = 'none';
        workspace.style.display = 'grid';
        recalculateAndRender();
    }
}

function renderImageToCanvas(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (event) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                canvas.width = img.naturalWidth;
                canvas.height = img.naturalHeight;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0);
                resolve(canvas);
            };
            img.onerror = () => reject(new Error("Image compilation error. File corrupted?"));
            img.src = event.target.result;
        };
        reader.readAsDataURL(file);
    });
}

async function renderPdfToCanvases(file) {
    const arrayBuffer = await file.arrayBuffer();
    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
    const pdf = await loadingTask.promise;
    const outputCanvases = [];

    const exactScaleRatio = state.dpi / 72; 

    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
        const page = await pdf.getPage(pageNum);
        const viewport = page.getViewport({ scale: exactScaleRatio }); 
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext('2d');
        
        await page.render({ canvasContext: ctx, viewport: viewport }).promise;
        outputCanvases.push(canvas);
    }
    return outputCanvases;
}

function calculateBleedInPixels() {
    if (state.bleedUnit === 'px') {
        return Math.round(state.bleedValue);
    } else if (state.bleedUnit === 'in') {
        return Math.round(state.bleedValue * state.dpi);
    } else { // mm
        const inches = state.bleedValue / 25.4;
        return Math.round(inches * state.dpi);
    }
}

// --- Core Mirrored & Blurred Bleed Algorithmic Canvas Engine ---
function generateMirroredBleedCanvas(srcCanvas, bPx) {
    const W = srcCanvas.width;
    const H = srcCanvas.height;
    const B = Math.max(0, Math.min(bPx, Math.floor(W / 2) - 2, Math.floor(H / 2) - 2));
    
    const outCanvas = document.createElement('canvas');
    outCanvas.width = W + (2 * B);
    outCanvas.height = H + (2 * B);
    const ctx = outCanvas.getContext('2d');

    if (B === 0) {
        ctx.drawImage(srcCanvas, 0, 0);
        return outCanvas;
    }

    const stageCanvas = document.createElement('canvas');
    stageCanvas.width = outCanvas.width;
    stageCanvas.height = outCanvas.height;
    const sCtx = stageCanvas.getContext('2d');

    sCtx.drawImage(srcCanvas, B, B);

    sCtx.save(); sCtx.translate(B, B); sCtx.scale(1, -1); sCtx.drawImage(srcCanvas, 0, 0, W, B, 0, 0, W, B); sCtx.restore();
    sCtx.save(); sCtx.translate(B, B + H); sCtx.scale(1, -1); sCtx.drawImage(srcCanvas, 0, H - B, W, B, 0, -B, W, B); sCtx.restore();
    sCtx.save(); sCtx.translate(B, B); sCtx.scale(-1, 1); sCtx.drawImage(srcCanvas, 0, 0, B, H, 0, 0, B, H); sCtx.restore();
    sCtx.save(); sCtx.translate(B + W, B); sCtx.scale(-1, 1); sCtx.drawImage(srcCanvas, W - B, 0, B, H, -B, 0, B, H); sCtx.restore();
    sCtx.save(); sCtx.translate(B, B); sCtx.scale(-1, -1); sCtx.drawImage(srcCanvas, 0, 0, B, B, 0, 0, B, B); sCtx.restore();
    sCtx.save(); sCtx.translate(B + W, B); sCtx.scale(-1, -1); sCtx.drawImage(srcCanvas, W - B, 0, B, B, -B, 0, B, B); sCtx.restore();
    sCtx.save(); sCtx.translate(B, B + H); sCtx.scale(-1, -1); sCtx.drawImage(srcCanvas, 0, H - B, B, B, 0, -B, B, B); sCtx.restore();
    sCtx.save(); sCtx.translate(B + W, B + H); sCtx.scale(-1, -1); sCtx.drawImage(srcCanvas, W - B, H - B, B, B, -B, -B, B, B); sCtx.restore();

    ctx.filter = 'blur(4px)';
    ctx.drawImage(stageCanvas, 0, 0);

    ctx.filter = 'none';
    ctx.drawImage(srcCanvas, B, B);

    return outCanvas;
}

// --- View Layer Controllers ---
function recalculateAndRender() {
    previewContainer.innerHTML = '';
    const bPx = calculateBleedInPixels();

    state.files.forEach((fileItem) => {
        const card = document.createElement('div');
        card.className = 'preview-card';

        const bledCanvas = generateMirroredBleedCanvas(fileItem.originalCanvas, bPx);
        
        const displayWidthIn = (bledCanvas.width / state.dpi).toFixed(3);
        const displayHeightIn = (bledCanvas.height / state.dpi).toFixed(3);

        const cardHeader = document.createElement('div');
        cardHeader.className = 'card-header';
        cardHeader.innerHTML = `
            <div class="card-title" title="${fileItem.name}">${fileItem.name}</div>
            <div class="card-dims">${displayWidthIn}" x ${displayHeightIn}"</div>
        `;

        const canvasWrapper = document.createElement('div');
        canvasWrapper.className = 'canvas-wrapper';
        
        const leftPct = (bPx / bledCanvas.width) * 100;
        const topPct = (bPx / bledCanvas.height) * 100;
        const widthPct = (fileItem.originalCanvas.width / bledCanvas.width) * 100;
        const heightPct = (fileItem.originalCanvas.height / bledCanvas.height) * 100;

        const guideOverlay = document.createElement('div');
        guideOverlay.className = 'trim-guide';
        guideOverlay.style.left = `${leftPct}%`;
        guideOverlay.style.top = `${topPct}%`;
        guideOverlay.style.width = `${widthPct}%`;
        guideOverlay.style.height = `${heightPct}%`;
        guideOverlay.style.display = state.showGuides ? 'block' : 'none';

        canvasWrapper.appendChild(bledCanvas);
        canvasWrapper.appendChild(guideOverlay);
        card.appendChild(cardHeader);
        card.appendChild(canvasWrapper);
        previewContainer.appendChild(card);
    });
}

function toggleGuideVisibility() {
    const guides = document.querySelectorAll('.trim-guide');
    guides.forEach(g => g.style.display = state.showGuides ? 'block' : 'none');
}

function resetApplicationState() {
    state.files = [];
    previewContainer.innerHTML = '';
    fileInput.value = '';
    workspace.style.display = 'none';
    dropZone.style.display = 'block';
}

// --- High-Fidelity Binary Metaspace PNG Injector ---
function injectPhysicalDpiMetadata(blobInstance, targetDpiValue) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = function(event) {
            const fileBytes = new Uint8Array(event.target.result);
            const pixelsPerMeter = Math.round(targetDpiValue / 0.0254);
            
            const blockData = new Uint8Array(9);
            blockData[0] = (pixelsPerMeter >>> 24) & 0xFF;
            blockData[1] = (pixelsPerMeter >>> 16) & 0xFF;
            blockData[2] = (pixelsPerMeter >>> 8) & 0xFF;
            blockData[3] = pixelsPerMeter & 0xFF;
            blockData[4] = (pixelsPerMeter >>> 24) & 0xFF;
            blockData[5] = (pixelsPerMeter >>> 16) & 0xFF;
            blockData[6] = (pixelsPerMeter >>> 8) & 0xFF;
            blockData[7] = pixelsPerMeter & 0xFF;
            blockData[8] = 0x01; 
            
            const blockType = new Uint8Array([112, 72, 89, 115]); 
            
            const combinedBuffer = new Uint8Array(blockType.length + blockData.length);
            combinedBuffer.set(blockType, 0);
            combinedBuffer.set(blockData, blockType.length);
            
            let c, crcTable = [];
            for (let n = 0; n < 256; n++) {
                c = n;
                for (let k = 0; k < 8; k++) {
                    c = ((c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1));
                }
                crcTable[n] = c;
            }
            let runningCrc = 0xFFFFFFFF;
            for (let i = 0; i < combinedBuffer.length; i++) {
                runningCrc = (runningCrc >>> 8) ^ crcTable[(runningCrc ^ combinedBuffer[i]) & 0xFF];
            }
            const finalChecksum = (runningCrc ^ 0xFFFFFFFF) >>> 0;
            
            const entireChunk = new Uint8Array(4 + 4 + 9 + 4);
            entireChunk[0] = 0; entireChunk[1] = 0; entireChunk[2] = 0; entireChunk[3] = 9;
            entireChunk.set(blockType, 4);
            entireChunk.set(blockData, 8);
            entireChunk[17] = (finalChecksum >>> 24) & 0xFF;
            entireChunk[18] = (finalChecksum >>> 16) & 0xFF;
            entireChunk[19] = (finalChecksum >>> 8) & 0xFF;
            entireChunk[20] = finalChecksum & 0xFF;
            
            const updatedFileStream = new Uint8Array(fileBytes.length + entireChunk.length);
            updatedFileStream.set(fileBytes.subarray(0, 33), 0);
            updatedFileStream.set(entireChunk, 33);
            updatedFileStream.set(fileBytes.subarray(33), 33 + entireChunk.length);
            
            resolve(new Blob([updatedFileStream], { type: 'image/png' }));
        };
        reader.readAsArrayBuffer(blobInstance);
    });
}

// --- Optimized Exporters ---
async function exportDocumentAsPDF() {
    if (state.files.length === 0) return;
    
    // Trigger the cyber loading screen immediately
    showLoading("PDF Compilation", "Initializing document stream compression vectors...");

    // Yield to the browser's render thread to guarantee the loading screen paints 
    // before the heavy synchronous PDF generation blocks the CPU.
    await new Promise(resolve => setTimeout(resolve, 100));

    try {
        const { jsPDF } = window.jspdf;
        const bPx = calculateBleedInPixels();
        let docMaster = null;

        for (let index = 0; index < state.files.length; index++) {
            const activeFile = state.files[index];
            const outCnv = generateMirroredBleedCanvas(activeFile.originalCanvas, bPx);
            
            const widthInches = outCnv.width / state.dpi;
            const heightInches = outCnv.height / state.dpi;
            const layoutDirection = widthInches > heightInches ? 'l' : 'p';

            if (index === 0) {
                docMaster = new jsPDF({ 
                    orientation: layoutDirection, 
                    unit: 'in', 
                    format: [widthInches, heightInches],
                    compress: true 
                });
            } else {
                docMaster.addPage([widthInches, heightInches], layoutDirection);
            }

            const canvasBlobDataUrl = outCnv.toDataURL('image/jpeg', 0.82); 
            docMaster.addImage(canvasBlobDataUrl, 'JPEG', 0, 0, widthInches, heightInches, undefined, 'FAST');

            // Yield briefly after each page to keep the loading animation actively spinning
            await new Promise(resolve => setTimeout(resolve, 10));
        }

        if (docMaster) {
            docMaster.save('press_ready_output_with_bleeds.pdf');
        }
    } catch (ex) {
        console.error("Export Engine encountered a fatal exception: ", ex);
        alert(`Export failed: ${ex.message}`);
    } finally {
        hideLoading();
    }
}

async function exportSlicesAsZIP() {
    if (state.files.length === 0) return;
    showLoading("ZIP Compression", "Injecting true physical inch dimensions into binary stream...");

    try {
        const zipEngine = new JSZip();
        const bPx = calculateBleedInPixels();

        for (let idx = 0; idx < state.files.length; idx++) {
            const item = state.files[idx];
            const outCnv = generateMirroredBleedCanvas(item.originalCanvas, bPx);
            
            const standardPixelBlob = await new Promise(res => outCnv.toBlob(res, 'image/png'));
            const accuratePrintSizeBlob = await injectPhysicalDpiMetadata(standardPixelBlob, state.dpi);
            
            let localizedCleanName = item.name.replace(/\.[^/.]+$/, ""); 
            zipEngine.file(`${localizedCleanName}_with_bleed_${idx + 1}.png`, accuratePrintSizeBlob);
        }

        const productionZipContent = await zipEngine.generateAsync({ type: "blob" });
        const virtualAnchor = document.createElement('a');
        virtualAnchor.href = URL.createObjectURL(productionZipContent);
        virtualAnchor.download = "press_ready_mirrored_bleed_images.zip";
        virtualAnchor.click();
        URL.revokeObjectURL(virtualAnchor.href);
    } catch (ex) {
        console.error("ZIP pipeline failure: ", ex);
        alert(`Archive compilation crashed: ${ex.message}`);
    } finally {
        hideLoading();
    }
}