pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// --- PURE-JS CMYK JPEG DETECTOR ---
// Scans JPEG binary for an Adobe APP14 marker (0xFFEE) which signals CMYK/YCCK color space.
// This replaces wasm-vips entirely — no WebAssembly or special HTTP headers required.
function detectJpegColorSpace(buffer) {
    const bytes = new Uint8Array(buffer);
    let i = 0;

    // Verify JPEG SOI marker
    if (bytes[0] !== 0xFF || bytes[1] !== 0xD8) return 'rgb';

    i = 2;
    while (i < bytes.length - 1) {
        if (bytes[i] !== 0xFF) break;

        const marker = bytes[i + 1];
        i += 2;

        // Skip padding bytes
        if (marker === 0xFF) { i--; continue; }
        // SOI / EOI have no length field
        if (marker === 0xD8 || marker === 0xD9) continue;

        const segLen = (bytes[i] << 8) | bytes[i + 1];

        // APP14 marker = Adobe segment
        if (marker === 0xEE && segLen >= 14) {
            // Bytes 2-6 of the segment data should be "Adobe"
            const isAdobe = bytes[i+2]===0x41 && bytes[i+3]===0x64 && bytes[i+4]===0x6F &&
                            bytes[i+5]===0x62 && bytes[i+6]===0x65;
            if (isAdobe) {
                // Color transform byte: 0 = unknown/CMYK, 2 = YCCK
                const colorTransform = bytes[i + 13];
                if (colorTransform === 0 || colorTransform === 2) return 'cmyk';
            }
        }

        // SOF markers carry the component count — 4 channels without APP14 also means CMYK
        if ((marker >= 0xC0 && marker <= 0xC3) || (marker >= 0xC5 && marker <= 0xCB) || (marker >= 0xCD && marker <= 0xCF)) {
            const components = bytes[i + 7];
            if (components === 4) return 'cmyk';
        }

        i += segLen;
    }
    return 'rgb';
}

// --- PANTONE SPOT COLOR DETECTOR (PDF only) ---
// Scans raw PDF bytes for Separation or DeviceN colorspace definitions whose
// name string contains "PANTONE". This is how spot colors are encoded in the
// PDF spec: e.g. [ /Separation /PANTONE#20485#20C /DeviceCMYK <<...>> ]
// Returns an array of unique Pantone color name strings found, or [] if none.
function detectPantoneSpotsInPdf(buffer) {
    const bytes  = new Uint8Array(buffer);
    const text   = new TextDecoder('latin1').decode(bytes); // latin1 = safe 1:1 byte mapping
    const found  = new Set();

    // Match /PANTONE ... / or (PANTONE ...) — both name-object and string-object forms
    const nameRe   = /\/([Pp][Aa][Nn][Tt][Oo][Nn][Ee][^\s\/\[\]<>()]{1,60})/g;
    const stringRe = /\(([Pp][Aa][Nn][Tt][Oo][Nn][Ee][^)]{1,60})\)/g;

    let m;
    while ((m = nameRe.exec(text))   !== null) found.add(m[1].replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).trim());
    while ((m = stringRe.exec(text)) !== null) found.add(m[1].trim());

    return [...found];
}

// Decode a raw CMYK JPEG into a 4-channel Uint8Array using an offscreen canvas.
// Browsers decode CMYK JPEGs to RGBA automatically; we invert back to CMYK values.
function decodeCmykJpeg(file, buffer) {
    return new Promise((resolve, reject) => {
        const blob = new Blob([buffer], { type: 'image/jpeg' });
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0);
            const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

            // Re-derive CMYK from the browser's RGBA output (inverted RGB → CMY, derive K)
            const cmyk = new Uint8Array(rgba.length);
            for (let i = 0; i < rgba.length; i += 4) {
                const r = rgba[i] / 255, g = rgba[i+1] / 255, b = rgba[i+2] / 255;
                const k = 1 - Math.max(r, g, b);
                const denom = (1 - k) || 1e-6;
                cmyk[i]   = Math.round(((1 - r - k) / denom) * 255); // C
                cmyk[i+1] = Math.round(((1 - g - k) / denom) * 255); // M
                cmyk[i+2] = Math.round(((1 - b - k) / denom) * 255); // Y
                cmyk[i+3] = Math.round(k * 255);                      // K
            }
            URL.revokeObjectURL(url);
            resolve({ data: cmyk, width: canvas.width, height: canvas.height });
        };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Failed to decode JPEG')); };
        img.src = url;
    });
}

// Local Application Memory State
const state = {
    files: [], 
    bleedValue: 0.125,
    bleedUnit: 'in',
    dpi: 300,
    showGuides: true
};

// DOM Cache
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

// Events
dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', handleDrop);
fileInput.addEventListener('change', handleFileSelect);

bleedUnit.addEventListener('change', (e) => {
    state.bleedUnit = e.target.value;
    if (state.bleedUnit === 'px') {
        dpiGroup.style.display = 'none';
        bleedValue.value = '35'; bleedValue.step = '1';
    } else if (state.bleedUnit === 'in') {
        dpiGroup.style.display = 'block';
        bleedValue.value = '0.125'; bleedValue.step = '0.01';
    } else {
        dpiGroup.style.display = 'block';
        bleedValue.value = '3'; bleedValue.step = '0.1';
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

function showLoading(headline, subtitle = "Processing...") { 
    loadingText.textContent = headline.toUpperCase(); 
    loadingSubtext.textContent = subtitle;
    loadingScreen.style.display = 'flex'; 
}
function hideLoading() { loadingScreen.style.display = 'none'; }

function handleDrop(e) { e.preventDefault(); dropZone.classList.remove('dragover'); processFiles(e.dataTransfer.files); }
function handleFileSelect(e) { processFiles(e.target.files); }

// --- FILE PIPELINE ---
async function processFiles(fileList) {
    if (fileList.length === 0) return;

    showLoading("Ingesting Assets", "Analyzing binary headers and color spaces...");

    for (const file of fileList) {
        try {
            if (file.type === 'image/jpeg') {
                const buffer = await file.arrayBuffer();

                // Pure-JS CMYK detection - reads JPEG binary markers, no WASM needed
                const colorSpace = detectJpegColorSpace(buffer);

                if (colorSpace === 'cmyk') {
                    // Decode CMYK JPEG to raw 4-channel pixel data for bleed math.
                    // Also stash the original ArrayBuffer so export can stamp the
                    // untouched source pixels over the bleed region at download time.
                    const cmykData = await decodeCmykJpeg(file, buffer);
                    state.files.push({
                        name: file.name,
                        type: 'cmyk',
                        cmykData,
                        originalBuffer: buffer  // pristine source — never mutated
                    });
                    continue;
                }
                // Falls through to standard RGB canvas handling below
            }

            if (file.type.startsWith('image/')) {
                const canvas = await renderImageToCanvas(file);
                state.files.push({ name: file.name, type: 'rgb', canvas: canvas });
            } else if (file.type === 'application/pdf') {
                const pdfBuffer = await file.arrayBuffer();

                // Scan for Pantone spot color names before rasterising
                const pantoneSpots = detectPantoneSpotsInPdf(pdfBuffer);
                const hasPantone   = pantoneSpots.length > 0;

                const canvases = await renderPdfToCanvases(file, pdfBuffer);
                canvases.forEach((canvas, idx) => {
                    state.files.push({
                        name: `${file.name} (Page ${idx + 1})`,
                        type: hasPantone ? 'pantone' : 'rgb',
                        canvas,
                        // Stash original buffer + spot names for Pantone files so export
                        // can embed the raw PDF bytes via pdf-lib (same strategy as CMYK)
                        ...(hasPantone && {
                            originalBuffer: pdfBuffer,
                            pantoneSpots,
                            pageIndex: idx
                        })
                    });
                });
            }
        } catch (err) {
            console.error(err);
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
                canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0);
                resolve(canvas);
            };
            img.onerror = () => reject(new Error("Image error."));
            img.src = event.target.result;
        };
        reader.readAsDataURL(file);
    });
}

async function renderPdfToCanvases(file, existingBuffer) {
    // Accept a pre-read buffer so callers that already read the file don't re-read it
    const arrayBuffer = existingBuffer !== undefined ? existingBuffer : await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer.slice(0) }).promise;
    const outputCanvases = [];
    const scaleRatio = state.dpi / 72; 
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
        const page = await pdf.getPage(pageNum);
        const viewport = page.getViewport({ scale: scaleRatio }); 
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width; canvas.height = viewport.height;
        await page.render({ canvasContext: canvas.getContext('2d'), viewport: viewport }).promise;
        outputCanvases.push(canvas);
    }
    return outputCanvases;
}

function calculateBleedInPixels() {
    if (state.bleedUnit === 'px') return Math.round(state.bleedValue);
    if (state.bleedUnit === 'in') return Math.round(state.bleedValue * state.dpi);
    return Math.round((state.bleedValue / 25.4) * state.dpi);
}

// --- RGB CANVAS ALGORITHM ---
function generateRGBBleedCanvas(srcCanvas, bPx) {
    const W = srcCanvas.width, H = srcCanvas.height;
    const B = Math.max(0, Math.min(bPx, Math.floor(W/2)-2, Math.floor(H/2)-2));
    const outCanvas = document.createElement('canvas');
    outCanvas.width = W + (2 * B); outCanvas.height = H + (2 * B);
    const ctx = outCanvas.getContext('2d');
    if (B === 0) { ctx.drawImage(srcCanvas, 0, 0); return outCanvas; }

    const stage = document.createElement('canvas');
    stage.width = outCanvas.width; stage.height = outCanvas.height;
    const sCtx = stage.getContext('2d');
    
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
    ctx.drawImage(stage, 0, 0);
    ctx.filter = 'none';
    ctx.drawImage(srcCanvas, B, B);
    return outCanvas;
}

// --- CMYK BINARY MATH ALGORITHMS ---
function mirrorAndBlurCMYK(srcDataObj, bPx) {
    const W = srcDataObj.width;
    const H = srcDataObj.height;
    const B = Math.max(0, Math.min(bPx, Math.floor(W/2)-2, Math.floor(H/2)-2));
    const destW = W + (B * 2);
    const destH = H + (B * 2);
    
    // 1. Mirror Array
    let outData = new Uint8Array(destW * destH * 4);
    const src = srcDataObj.data;

    for (let y = 0; y < destH; y++) {
        for (let x = 0; x < destW; x++) {
            let sx = x - B;
            let sy = y - B;
            if (sx < 0) sx = -sx - 1; else if (sx >= W) sx = W - (sx - W) - 1;
            if (sy < 0) sy = -sy - 1; else if (sy >= H) sy = H - (sy - H) - 1;
            
            const srcIdx = (sy * W + sx) * 4;
            const dstIdx = (y * destW + x) * 4;
            outData[dstIdx] = src[srcIdx];
            outData[dstIdx+1] = src[srcIdx+1];
            outData[dstIdx+2] = src[srcIdx+2];
            outData[dstIdx+3] = src[srcIdx+3];
        }
    }

    if (B > 0) {
        // 2. Simple Box Blur (radius 3) on the entire array
        const rad = 3;
        const temp = new Uint8Array(outData.length);
        
        // Horizontal pass
        for (let y = 0; y < destH; y++) {
            for (let x = 0; x < destW; x++) {
                let c=0, m=0, yy=0, k=0, count=0;
                for (let r = -rad; r <= rad; r++) {
                    let nx = Math.max(0, Math.min(destW-1, x + r));
                    let idx = (y * destW + nx) * 4;
                    c += outData[idx]; m += outData[idx+1]; yy += outData[idx+2]; k += outData[idx+3];
                    count++;
                }
                let out = (y * destW + x) * 4;
                temp[out] = c/count; temp[out+1] = m/count; temp[out+2] = yy/count; temp[out+3] = k/count;
            }
        }
        
        // Vertical pass (write back to outData)
        for (let y = 0; y < destH; y++) {
            for (let x = 0; x < destW; x++) {
                let c=0, m=0, yy=0, k=0, count=0;
                for (let r = -rad; r <= rad; r++) {
                    let ny = Math.max(0, Math.min(destH-1, y + r));
                    let idx = (ny * destW + x) * 4;
                    c += temp[idx]; m += temp[idx+1]; yy += temp[idx+2]; k += temp[idx+3];
                    count++;
                }
                let out = (y * destW + x) * 4;
                outData[out] = c/count; outData[out+1] = m/count; outData[out+2] = yy/count; outData[out+3] = k/count;
            }
        }

        // NOTE: The blurred mirror fills the entire canvas including the center.
        // compositeOriginalCMYK() stamps the pristine original back at export time.
    }

    return { data: outData, width: destW, height: destH };
}

// --- PDF-LIB: Build a true CMYK-preserving PDF for a single CMYK file ---
//
// Algorithm (your design, implemented with pdf-lib):
//   Layer 1 — Bleed canvas JPEG (full W+2B × H+2B) drawn at position (0, 0).
//             This is the mirrored+blurred border canvas converted to JPEG via canvas.toBlob().
//             pdf-lib embeds it as a DCTDecode stream — no re-encode, color intact.
//   Layer 2 — Original JPEG (W × H) drawn at position (bleedPts, bleedPts) on top.
//             This is the raw originalBuffer bytes passed directly to embedJpg().
//             pdf-lib stores them verbatim as DCTDecode — zero pixel manipulation,
//             ICC profile and all CMYK channel data fully preserved.
//
// Result: a PDF page whose bleed zone contains the blurred mirror, and whose center
// contains the exact original source bytes — not re-derived, not math-processed.
//
// PDF uses points (1 pt = 1/72 inch). We size the page so that at the target DPI
// the pixel dimensions map 1:1 to physical inches.
async function buildCmykBleedPdf(fileItem, bPx, dpi) {
    const { PDFDocument } = PDFLib;

    // 1. Build the bleed canvas (blurred mirror, center zone also blurred at this stage)
    const bleedCMYK = mirrorAndBlurCMYK(fileItem.cmykData, bPx);
    const bleedCanvas = createGhostRgbCanvas(bleedCMYK); // RGB ghost — only used to get JPEG bytes for the bleed layer

    // 2. Encode the bleed canvas to JPEG bytes (this is the background layer only — bleed zone)
    const bleedJpegBlob = await new Promise(res => bleedCanvas.toBlob(res, 'image/jpeg', 0.92));
    const bleedJpegBytes = new Uint8Array(await bleedJpegBlob.arrayBuffer());

    // 3. The original is taken straight from originalBuffer — no decoding, no math, no re-encode
    const originalBytes = new Uint8Array(fileItem.originalBuffer);

    // 4. Compute page size in PDF points
    const totalW = bleedCMYK.width;   // W + 2*B pixels
    const totalH = bleedCMYK.height;
    const origW  = fileItem.cmykData.width;
    const origH  = fileItem.cmykData.height;

    const pageWidthPt  = (totalW / dpi) * 72;
    const pageHeightPt = (totalH / dpi) * 72;
    const bleedOffsetPt = (bPx   / dpi) * 72;
    const origWidthPt   = (origW  / dpi) * 72;
    const origHeightPt  = (origH  / dpi) * 72;

    // 5. Create PDF and embed both images
    const pdfDoc = await PDFDocument.create();
    const page   = pdfDoc.addPage([pageWidthPt, pageHeightPt]);

    // Layer 1: bleed background — fills entire page
    const bleedImg = await pdfDoc.embedJpg(bleedJpegBytes);
    page.drawImage(bleedImg, {
        x: 0,
        y: 0,
        width:  pageWidthPt,
        height: pageHeightPt,
    });

    // Layer 2: original JPEG — stamped over the center, offset by bleed amount.
    // pdf-lib PDF coordinate origin is bottom-left, so y = bleedOffsetPt (not top).
    const origImg = await pdfDoc.embedJpg(originalBytes);
    page.drawImage(origImg, {
        x: bleedOffsetPt,
        y: bleedOffsetPt,
        width:  origWidthPt,
        height: origHeightPt,
    });

    return pdfDoc.save(); // Uint8Array
}

// --- PDF-LIB: Build a Pantone-preserving bleed PDF for a single PDF page ---
//
// Strategy mirrors CMYK: the original PDF bytes are NEVER pixel-manipulated.
//   Layer 1 — Rasterised bleed canvas (RGB ghost) encoded to JPEG and drawn at (0,0).
//             Fills the full W+2B × H+2B page area with the blurred mirror bleed.
//   Layer 2 — The original PDF page embedded via embedPdf() / drawPage() placed at
//             (bleedOffsetPt, bleedOffsetPt), exactly covering the center zone.
//             pdf-lib copies the page's content stream verbatim — Separation and
//             DeviceN colorspaces (Pantone) are preserved in the PDF object graph.
//
// The user gets a PDF whose bleed border is a JPEG-blurred mirror and whose center
// is the intact, unmodified original page with all spot color separations intact.
async function buildPantoneBleedPdf(fileItem, bPx, dpi) {
    const { PDFDocument } = PDFLib;

    // 1. Build the bleed canvas from the rasterised version already in fileItem.canvas
    const bleedCanvas = generateRGBBleedCanvas(fileItem.canvas, bPx);

    // 2. Encode bleed canvas to JPEG (background layer only)
    const bleedJpegBlob  = await new Promise(res => bleedCanvas.toBlob(res, 'image/jpeg', 0.92));
    const bleedJpegBytes = new Uint8Array(await bleedJpegBlob.arrayBuffer());

    // 3. Compute page dimensions in PDF points
    const totalW = bleedCanvas.width;
    const totalH = bleedCanvas.height;
    const origW  = fileItem.canvas.width;
    const origH  = fileItem.canvas.height;

    const pageWidthPt   = (totalW / dpi) * 72;
    const pageHeightPt  = (totalH / dpi) * 72;
    const bleedOffsetPt = (bPx    / dpi) * 72;
    const origWidthPt   = (origW  / dpi) * 72;
    const origHeightPt  = (origH  / dpi) * 72;

    // 4. Load the original PDF and embed the specific page
    const srcDoc  = await PDFDocument.load(fileItem.originalBuffer, { ignoreEncryption: true });
    const outDoc  = await PDFDocument.create();
    const page    = outDoc.addPage([pageWidthPt, pageHeightPt]);

    // Layer 1: bleed JPEG background
    const bleedImg = await outDoc.embedJpg(bleedJpegBytes);
    page.drawImage(bleedImg, { x: 0, y: 0, width: pageWidthPt, height: pageHeightPt });

    // Layer 2: original PDF page content — spot colors preserved
    const [embeddedPage] = await outDoc.embedPdf(srcDoc, [fileItem.pageIndex]);
    page.drawPage(embeddedPage, {
        x:      bleedOffsetPt,
        y:      bleedOffsetPt,
        width:  origWidthPt,
        height: origHeightPt,
    });

    return outDoc.save(); // Uint8Array
}

// Convert mathematical CMYK back to RGB just for Browser preview/DOM Canvas
function createGhostRgbCanvas(cmykObj) {
    const canvas = document.createElement('canvas');
    canvas.width = cmykObj.width; canvas.height = cmykObj.height;
    const ctx = canvas.getContext('2d');
    const imgData = ctx.createImageData(cmykObj.width, cmykObj.height);
    
    for (let i = 0; i < cmykObj.data.length; i += 4) {
        let c = cmykObj.data[i] / 255;
        let m = cmykObj.data[i+1] / 255;
        let y = cmykObj.data[i+2] / 255;
        let k = cmykObj.data[i+3] / 255;
        
        imgData.data[i] = 255 * (1 - c) * (1 - k);     // R
        imgData.data[i+1] = 255 * (1 - m) * (1 - k);   // G
        imgData.data[i+2] = 255 * (1 - y) * (1 - k);   // B
        imgData.data[i+3] = 255;                       // A
    }
    ctx.putImageData(imgData, 0, 0);
    return canvas;
}

// --- VIEW CONTROLLER ---
async function recalculateAndRender() {
    previewContainer.innerHTML = '';
    const bPx = calculateBleedInPixels();

    for (const fileItem of state.files) {
        const card = document.createElement('div');
        card.className = 'preview-card';
        
        let displayWidthIn, displayHeightIn, displayCanvas, innerWidth, innerHeight;
        
        if (fileItem.type === 'rgb' || fileItem.type === 'pantone') {
            // Pantone files were rasterised on intake (canvas is available) — bleed same as RGB
            const bledCanvas = generateRGBBleedCanvas(fileItem.canvas, bPx);
            displayCanvas   = bledCanvas;
            displayWidthIn  = (bledCanvas.width  / state.dpi).toFixed(3);
            displayHeightIn = (bledCanvas.height / state.dpi).toFixed(3);
            innerWidth  = fileItem.canvas.width;
            innerHeight = fileItem.canvas.height;
        } else {
            const processedCMYK = mirrorAndBlurCMYK(fileItem.cmykData, bPx);
            displayCanvas   = createGhostRgbCanvas(processedCMYK);
            displayWidthIn  = (processedCMYK.width  / state.dpi).toFixed(3);
            displayHeightIn = (processedCMYK.height / state.dpi).toFixed(3);
            innerWidth  = fileItem.cmykData.width;
            innerHeight = fileItem.cmykData.height;
        }

        // Build badge — Pantone files get their own badge + a tooltip listing spot names
        let modeBadge;
        if (fileItem.type === 'cmyk') {
            modeBadge = `<span class="badge badge-cmyk">CMYK RAW</span>`;
        } else if (fileItem.type === 'pantone') {
            const tipNames = fileItem.pantoneSpots.join(', ');
            const shortLabel = fileItem.pantoneSpots.length === 1
                ? fileItem.pantoneSpots[0]
                : `${fileItem.pantoneSpots.length} Spot Colors`;
            modeBadge = `<span class="badge badge-pantone" title="${tipNames}">🎨 ${shortLabel}</span>`;
        } else {
            modeBadge = `<span class="badge badge-rgb">RGB</span>`;
        }

        const cardHeader = document.createElement('div');
        cardHeader.className = 'card-header';
        cardHeader.innerHTML = `
            <div class="card-title" title="${fileItem.name}">${fileItem.name}</div>
            <div class="card-dims">${modeBadge} ${displayWidthIn}" x ${displayHeightIn}"</div>
        `;

        const canvasWrapper = document.createElement('div');
        canvasWrapper.className = 'canvas-wrapper';
        
        const leftPct = (bPx / displayCanvas.width) * 100;
        const topPct = (bPx / displayCanvas.height) * 100;
        const widthPct = (innerWidth / displayCanvas.width) * 100;
        const heightPct = (innerHeight / displayCanvas.height) * 100;

        const guideOverlay = document.createElement('div');
        guideOverlay.className = 'trim-guide';
        guideOverlay.style.left = `${leftPct}%`; guideOverlay.style.top = `${topPct}%`;
        guideOverlay.style.width = `${widthPct}%`; guideOverlay.style.height = `${heightPct}%`;
        guideOverlay.style.display = state.showGuides ? 'block' : 'none';

        canvasWrapper.appendChild(displayCanvas);
        canvasWrapper.appendChild(guideOverlay);
        card.appendChild(cardHeader);
        card.appendChild(canvasWrapper);
        previewContainer.appendChild(card);
        
        await new Promise(r => setTimeout(r, 10)); // keep UI unblocked
    }
}

function toggleGuideVisibility() {
    const guides = document.querySelectorAll('.trim-guide');
    guides.forEach(g => g.style.display = state.showGuides ? 'block' : 'none');
}

function resetApplicationState() {
    state.files = []; previewContainer.innerHTML = '';
    fileInput.value = ''; workspace.style.display = 'none';
    dropZone.style.display = 'block';
}

// --- TIFF CMYK BINARY ENCODER ---
function encodeToCMYK_TIFF(cmykDataObj, dpi) {
    const { width, height, data } = cmykDataObj;
    const pixelBytes = width * height * 4;

    const BPS_OFFSET  = 158; 
    const XRES_OFFSET = 166;
    const YRES_OFFSET = 174;
    const DATA_OFFSET = 182;

    const totalBytes = DATA_OFFSET + pixelBytes;
    const buffer = new ArrayBuffer(totalBytes);
    const view   = new DataView(buffer);

    view.setUint16(0, 0x4949, true); 
    view.setUint16(2, 42,     true); 
    view.setUint32(4, 8,      true); 
    view.setUint16(8, 12, true); 

    let ptr = 10;
    const addTag = (tag, type, count, valOrOffset) => {
        view.setUint16(ptr,     tag,         true);
        view.setUint16(ptr + 2, type,        true);
        view.setUint32(ptr + 4, count,       true);
        view.setUint32(ptr + 8, valOrOffset, true);
        ptr += 12;
    };

    addTag(256, 4, 1, width);         
    addTag(257, 4, 1, height);        
    addTag(258, 3, 4, BPS_OFFSET);    
    addTag(259, 3, 1, 1);             
    addTag(262, 3, 1, 5);             
    addTag(273, 4, 1, DATA_OFFSET);   
    addTag(277, 3, 1, 4);             
    addTag(278, 4, 1, height);        
    addTag(279, 4, 1, pixelBytes);    
    addTag(282, 5, 1, XRES_OFFSET);   
    addTag(283, 5, 1, YRES_OFFSET);   
    addTag(296, 3, 1, 2);             

    view.setUint32(ptr, 0, true);

    view.setUint16(BPS_OFFSET,     8, true);
    view.setUint16(BPS_OFFSET + 2, 8, true);
    view.setUint16(BPS_OFFSET + 4, 8, true);
    view.setUint16(BPS_OFFSET + 6, 8, true);

    view.setUint32(XRES_OFFSET,     dpi, true);
    view.setUint32(XRES_OFFSET + 4, 1,   true);
    view.setUint32(YRES_OFFSET,     dpi, true);
    view.setUint32(YRES_OFFSET + 4, 1,   true);

    new Uint8Array(buffer, DATA_OFFSET).set(data);

    return new Blob([buffer], { type: 'image/tiff' });
}

// Custom PNG DPI Injector for RGB files
function injectPhysicalDpiMetadata(blobInstance, targetDpiValue) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = function(event) {
            const fileBytes = new Uint8Array(event.target.result);
            const ppm = Math.round(targetDpiValue / 0.0254);
            const blockData = new Uint8Array(9);
            blockData[0] = (ppm >>> 24) & 0xFF; blockData[1] = (ppm >>> 16) & 0xFF; blockData[2] = (ppm >>> 8) & 0xFF; blockData[3] = ppm & 0xFF;
            blockData[4] = (ppm >>> 24) & 0xFF; blockData[5] = (ppm >>> 16) & 0xFF; blockData[6] = (ppm >>> 8) & 0xFF; blockData[7] = ppm & 0xFF;
            blockData[8] = 0x01; 
            const blockType = new Uint8Array([112, 72, 89, 115]); 
            const combinedBuffer = new Uint8Array(blockType.length + blockData.length);
            combinedBuffer.set(blockType, 0); combinedBuffer.set(blockData, blockType.length);
            
            let c, crcTable = [];
            for (let n = 0; n < 256; n++) {
                c = n; for (let k = 0; k < 8; k++) { c = ((c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)); }
                crcTable[n] = c;
            }
            let runningCrc = 0xFFFFFFFF;
            for (let i = 0; i < combinedBuffer.length; i++) { runningCrc = (runningCrc >>> 8) ^ crcTable[(runningCrc ^ combinedBuffer[i]) & 0xFF]; }
            const finalChecksum = (runningCrc ^ 0xFFFFFFFF) >>> 0;
            
            const entireChunk = new Uint8Array(4 + 4 + 9 + 4);
            entireChunk[3] = 9;
            entireChunk.set(blockType, 4); entireChunk.set(blockData, 8);
            entireChunk[17] = (finalChecksum >>> 24) & 0xFF; entireChunk[18] = (finalChecksum >>> 16) & 0xFF; entireChunk[19] = (finalChecksum >>> 8) & 0xFF; entireChunk[20] = finalChecksum & 0xFF;
            
            const updatedFileStream = new Uint8Array(fileBytes.length + entireChunk.length);
            updatedFileStream.set(fileBytes.subarray(0, 33), 0);
            updatedFileStream.set(entireChunk, 33);
            updatedFileStream.set(fileBytes.subarray(33), 33 + entireChunk.length);
            resolve(new Blob([updatedFileStream], { type: 'image/png' }));
        };
        reader.readAsArrayBuffer(blobInstance);
    });
}

// --- EXPORT LOGIC ---
async function exportDocumentAsPDF() {
    if (state.files.length === 0) return;
    showLoading("PDF Compilation", "Building print-ready PDF with CMYK color preservation...");
    await new Promise(resolve => setTimeout(resolve, 50));

    try {
        const { PDFDocument } = PDFLib;
        const bPx = calculateBleedInPixels();

        // Master pdf-lib document — all pages land here.
        // RGB pages are rendered to canvas → JPEG → embedJpg.
        // CMYK pages use buildCmykBleedPdf() then their page is copied in via copyPages().
        const masterDoc = await PDFDocument.create();

        for (let i = 0; i < state.files.length; i++) {
            const fileItem = state.files[i];
            await new Promise(r => setTimeout(r, 10)); // keep UI responsive

            if (fileItem.type === 'rgb') {
                // RGB path: canvas → JPEG → pdf-lib page
                const bleedCanvas = generateRGBBleedCanvas(fileItem.canvas, bPx);
                const jpegBlob = await new Promise(res => bleedCanvas.toBlob(res, 'image/jpeg', 0.92));
                const jpegBytes = new Uint8Array(await jpegBlob.arrayBuffer());

                const widthPt  = (bleedCanvas.width  / state.dpi) * 72;
                const heightPt = (bleedCanvas.height / state.dpi) * 72;

                const img  = await masterDoc.embedJpg(jpegBytes);
                const page = masterDoc.addPage([widthPt, heightPt]);
                page.drawImage(img, { x: 0, y: 0, width: widthPt, height: heightPt });

            } else if (fileItem.type === 'pantone') {
                // Pantone path: bleed JPEG bg + original PDF page embedded on top (spot colors preserved)
                const pantPdfBytes = await buildPantoneBleedPdf(fileItem, bPx, state.dpi);
                const pantDoc      = await PDFDocument.load(pantPdfBytes);
                const [copiedPage] = await masterDoc.copyPages(pantDoc, [0]);
                masterDoc.addPage(copiedPage);

            } else {
                // CMYK path: bleed JPEG bg + original JPEG on top (CMYK DCTDecode preserved)
                const cmykPdfBytes = await buildCmykBleedPdf(fileItem, bPx, state.dpi);
                const cmykDoc      = await PDFDocument.load(cmykPdfBytes);
                const [copiedPage] = await masterDoc.copyPages(cmykDoc, [0]);
                masterDoc.addPage(copiedPage);
            }
        }

        const pdfBytes = await masterDoc.save();
        const blob = new Blob([pdfBytes], { type: 'application/pdf' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'press_ready_proof.pdf';
        a.click();
        URL.revokeObjectURL(a.href);

    } catch (ex) { alert(`Export failed: ${ex.message}`); }
    finally { hideLoading(); }
}

async function exportSlicesAsZIP() {
    if (state.files.length === 0) return;
    showLoading("ZIP Compression", "Exporting print-ready files with CMYK preservation...");
    await new Promise(resolve => setTimeout(resolve, 50));

    try {
        const zipEngine = new JSZip();
        const bPx = calculateBleedInPixels();

        for (let i = 0; i < state.files.length; i++) {
            const item = state.files[i];
            let cleanName = item.name.replace(/\.[^/.]+$/, "");

            if (item.type === 'rgb') {
                // RGB: PNG with embedded DPI metadata
                const outCnv = generateRGBBleedCanvas(item.canvas, bPx);
                const blob    = await new Promise(res => outCnv.toBlob(res, 'image/png'));
                const dpiBlob = await injectPhysicalDpiMetadata(blob, state.dpi);
                zipEngine.file(`${cleanName}_bleed_rgb_${i + 1}.png`, dpiBlob);

            } else if (item.type === 'pantone') {
                // Pantone: PDF only — bleed JPEG bg + original PDF page embedded on top.
                // Spot color separations (Separation/DeviceN) are preserved via pdf-lib embedPdf.
                const pantPdfBytes = await buildPantoneBleedPdf(item, bPx, state.dpi);
                zipEngine.file(`${cleanName}_bleed_pantone_${i + 1}.pdf`, pantPdfBytes);

            } else {
                // CMYK: two outputs per file —
                //   1. TIFF  — raw 4-channel data for apps that read flat CMYK TIFF
                //   2. PDF   — two-layer pdf-lib document: bleed bg + original on top
                //              (true CMYK preservation via DCTDecode, no pixel math on source)

                // ── TIFF: bleed canvas with original center stamped back (pixel math path) ──
                const bleedCMYK   = mirrorAndBlurCMYK(item.cmykData, bPx);
                // Stamp original center back for TIFF export (keeps the raw channel data)
                const src = item.cmykData.data;
                const W   = item.cmykData.width, H = item.cmykData.height;
                const B   = Math.max(0, Math.min(bPx, Math.floor(W/2)-2, Math.floor(H/2)-2));
                const dW  = bleedCMYK.width;
                for (let y = 0; y < H; y++) {
                    for (let x = 0; x < W; x++) {
                        const sIdx = (y * W + x) * 4;
                        const dIdx = ((y + B) * dW + (x + B)) * 4;
                        bleedCMYK.data[dIdx]   = src[sIdx];
                        bleedCMYK.data[dIdx+1] = src[sIdx+1];
                        bleedCMYK.data[dIdx+2] = src[sIdx+2];
                        bleedCMYK.data[dIdx+3] = src[sIdx+3];
                    }
                }
                const tiffBlob = encodeToCMYK_TIFF(bleedCMYK, state.dpi);
                zipEngine.file(`${cleanName}_bleed_cmyk_${i + 1}.tiff`, tiffBlob);

                // ── PDF: pdf-lib two-layer approach — original bytes untouched ──
                const cmykPdfBytes = await buildCmykBleedPdf(item, bPx, state.dpi);
                zipEngine.file(`${cleanName}_bleed_cmyk_${i + 1}.pdf`, cmykPdfBytes);
            }

            await new Promise(r => setTimeout(r, 10));
        }

        const zipContent = await zipEngine.generateAsync({ type: "blob" });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(zipContent);
        a.download = "press_ready_files.zip";
        a.click();
        URL.revokeObjectURL(a.href);
    } catch (ex) { alert(`Archive crashed: ${ex.message}`); }
    finally { hideLoading(); }
}