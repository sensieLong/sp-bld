pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// --- PURE-JS CMYK JPEG DETECTOR ---
function detectJpegColorSpace(buffer) {
    const bytes = new Uint8Array(buffer);
    let i = 0;
    if (bytes[0] !== 0xFF || bytes[1] !== 0xD8) return 'rgb';

    i = 2;
    while (i < bytes.length - 1) {
        if (bytes[i] !== 0xFF) break;
        const marker = bytes[i + 1];
        i += 2;
        if (marker === 0xFF) { i--; continue; }
        if (marker === 0xD8 || marker === 0xD9) continue;
        const segLen = (bytes[i] << 8) | bytes[i + 1];

        if (marker === 0xEE && segLen >= 14) {
            const isAdobe = bytes[i+2]===0x41 && bytes[i+3]===0x64 && bytes[i+4]===0x6F && bytes[i+5]===0x62 && bytes[i+6]===0x65;
            if (isAdobe) {
                const colorTransform = bytes[i + 13];
                if (colorTransform === 0 || colorTransform === 2) return 'cmyk';
            }
        }
        if ((marker >= 0xC0 && marker <= 0xC3) || (marker >= 0xC5 && marker <= 0xCB) || (marker >= 0xCD && marker <= 0xCF)) {
            const components = bytes[i + 7];
            if (components === 4) return 'cmyk';
        }
        i += segLen;
    }
    return 'rgb';
}

// --- PANTONE SPOT COLOR DETECTOR (PDF only) ---
function detectPantoneSpotsInPdf(buffer) {
    const text  = new TextDecoder('latin1').decode(new Uint8Array(buffer));
    const spots = new Map();

    function decodePdfName(raw) {
        return raw.replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).trim();
    }

    function extractCmykValues(chunk) {
        const numRe = /([01]?\.\d+|\d+\.?\d*)/g;
        const nums  = [];
        let nm;
        while ((nm = numRe.exec(chunk)) !== null) {
            const v = parseFloat(nm[1]);
            if (v >= 0 && v <= 1) nums.push(v);
            if (nums.length >= 4) break;
        }
        if (nums.length >= 4) return { C: nums[0], M: nums[1], Y: nums[2], K: nums[3] };
        return null;
    }

    const sepRe = /\[\/Separation\s+\/([^\s\[\]]+)\s+\/DeviceCMYK\s+(.{1,400}?)\]/gs;
    let m;
    while ((m = sepRe.exec(text)) !== null) {
        const rawName = m[1];
        if (!/pantone/i.test(rawName)) continue;
        const name = decodePdfName(rawName);
        if (spots.has(name)) continue;
        const cmyk = extractCmykValues(m[2]) || { C:0, M:0, Y:0, K:1 };
        spots.set(name, cmyk);
    }

    const nameRe   = /\/([Pp][Aa][Nn][Tt][Oo][Nn][Ee][^\s\/\[\]<>()]{1,60})/g;
    const stringRe = /\(([Pp][Aa][Nn][Tt][Oo][Nn][Ee][^)]{1,60})\)/g;
    while ((m = nameRe.exec(text))   !== null) {
        const name = decodePdfName(m[1]);
        if (!spots.has(name)) spots.set(name, { C:0, M:0, Y:0, K:1 });
    }
    while ((m = stringRe.exec(text)) !== null) {
        const name = m[1].trim();
        if (!spots.has(name)) spots.set(name, { C:0, M:0, Y:0, K:1 });
    }

    return [...spots.entries()].map(([name, cmyk]) => ({ name, ...cmyk }));
}

// --- PDF CMYK DETECTOR ---
function detectCmykInPdf(buffer) {
    const text = new TextDecoder('latin1').decode(new Uint8Array(buffer));
    return /\/DeviceCMYK/.test(text) || /\/ColorSpace\s*\/CMYK/.test(text) || /\/CS\s*\/CMYK/.test(text);
}

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

            const cmyk = new Uint8Array(rgba.length);
            for (let i = 0; i < rgba.length; i += 4) {
                const r = rgba[i] / 255, g = rgba[i+1] / 255, b = rgba[i+2] / 255;
                const k = 1 - Math.max(r, g, b);
                const denom = (1 - k) || 1e-6;
                cmyk[i]   = Math.round(((1 - r - k) / denom) * 255);
                cmyk[i+1] = Math.round(((1 - g - k) / denom) * 255);
                cmyk[i+2] = Math.round(((1 - b - k) / denom) * 255);
                cmyk[i+3] = Math.round(k * 255);
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
    files: [], bleedValue: 0.125, bleedUnit: 'in', dpi: 300, showGuides: true, bleedMode: 'blur-mirror'
};

// DOM Cache
const dropZone = document.getElementById('dropZone'), fileInput = document.getElementById('fileInput'),
      workspace = document.getElementById('workspace'), previewContainer = document.getElementById('previewContainer'),
      bleedUnit = document.getElementById('bleedUnit'), bleedValue = document.getElementById('bleedValue'),
      dpiInput = document.getElementById('dpiInput'), dpiGroup = document.getElementById('dpiGroup'),
      toggleGuides = document.getElementById('toggleGuides'), btnExportPDF = document.getElementById('btnExportPDF'),
      btnExportZIP = document.getElementById('btnExportZIP'), btnClear = document.getElementById('btnClear'),
      loadingScreen = document.getElementById('loadingScreen'), loadingText = document.getElementById('loadingText'),
      loadingSubtext = document.getElementById('loadingSubtext');

// Events
dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', handleDrop);
fileInput.addEventListener('change', handleFileSelect);

bleedUnit.addEventListener('change', (e) => {
    state.bleedUnit = e.target.value;
    if (state.bleedUnit === 'px') { dpiGroup.style.display = 'none'; bleedValue.value = '35'; bleedValue.step = '1'; }
    else if (state.bleedUnit === 'in') { dpiGroup.style.display = 'block'; bleedValue.value = '0.125'; bleedValue.step = '0.01'; }
    else { dpiGroup.style.display = 'block'; bleedValue.value = '3'; bleedValue.step = '0.1'; }
    state.bleedValue = parseFloat(bleedValue.value); recalculateAndRender();
});

bleedValue.addEventListener('input', (e) => { state.bleedValue = parseFloat(e.target.value) || 0; recalculateAndRender(); });
dpiInput.addEventListener('input', (e) => { state.dpi = parseInt(e.target.value) || 300; recalculateAndRender(); });
toggleGuides.addEventListener('change', (e) => { state.showGuides = e.target.checked; toggleGuideVisibility(); });
btnClear.addEventListener('click', resetApplicationState);
document.querySelectorAll('input[name="bleedMode"]').forEach(r => r.addEventListener('change', (e) => { state.bleedMode = e.target.value; recalculateAndRender(); }));
btnExportPDF.addEventListener('click', exportDocumentAsPDF);
btnExportZIP.addEventListener('click', exportSlicesAsZIP);

function showLoading(headline, subtitle = "Processing...") { 
    loadingText.textContent = headline.toUpperCase(); loadingSubtext.textContent = subtitle; loadingScreen.style.display = 'flex'; 
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
                const colorSpace = detectJpegColorSpace(buffer);
                if (colorSpace === 'cmyk') {
                    const cmykData = await decodeCmykJpeg(file, buffer);
                    state.files.push({ name: file.name, type: 'cmyk', cmykData, originalBuffer: buffer });
                    continue;
                }
            }
            if (file.type.startsWith('image/')) {
                const canvas = await renderImageToCanvas(file);
                state.files.push({ name: file.name, type: 'rgb', canvas: canvas });
            } else if (file.type === 'application/pdf') {
                const pdfBuffer = await file.arrayBuffer();
                const pantoneSpots = detectPantoneSpotsInPdf(pdfBuffer);
                const hasPantone   = pantoneSpots.length > 0;
                const hasCmyk      = !hasPantone && detectCmykInPdf(pdfBuffer);
                const canvases = await renderPdfToCanvases(file, pdfBuffer);
                
                canvases.forEach((canvas, idx) => {
                    let type = 'rgb';
                    if (hasPantone) type = 'pantone';
                    else if (hasCmyk) type = 'pdf-cmyk';
                    state.files.push({
                        name: `${file.name} (Page ${idx + 1})`, type, canvas,
                        ...((hasPantone || hasCmyk) && { originalBuffer: pdfBuffer, pageIndex: idx, ...(hasPantone && { pantoneSpots }) })
                    });
                });
            }
        } catch (err) { console.error(err); alert(`Error parsing file ${file.name}: ${err.message}`); }
    }
    hideLoading();
    if (state.files.length > 0) { dropZone.style.display = 'none'; workspace.style.display = 'grid'; recalculateAndRender(); }
}

function renderImageToCanvas(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (event) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas'); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
                canvas.getContext('2d').drawImage(img, 0, 0); resolve(canvas);
            };
            img.onerror = () => reject(new Error("Image error.")); img.src = event.target.result;
        };
        reader.readAsDataURL(file);
    });
}

async function renderPdfToCanvases(file, existingBuffer) {
    const arrayBuffer = existingBuffer !== undefined ? existingBuffer : await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer.slice(0) }).promise;
    const outputCanvases = [];
    const scaleRatio = state.dpi / 72; 
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
        const page = await pdf.getPage(pageNum);
        const viewport = page.getViewport({ scale: scaleRatio }); 
        const canvas = document.createElement('canvas'); canvas.width = viewport.width; canvas.height = viewport.height;
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

// --- RGB CANVAS ALGORITHM (mode-aware) ---
function generateRGBBleedCanvas(srcCanvas, bPx, mode) {
    if (!mode) mode = state.bleedMode || 'blur-mirror';
    const W = srcCanvas.width, H = srcCanvas.height;
    const B = Math.max(0, Math.min(bPx, Math.floor(W/2)-2, Math.floor(H/2)-2));
    const outCanvas = document.createElement('canvas');
    outCanvas.width = W + (2 * B); outCanvas.height = H + (2 * B);
    const ctx = outCanvas.getContext('2d');
    if (B === 0) { ctx.drawImage(srcCanvas, 0, 0); return outCanvas; }

    const doMirror = mode === 'blur-mirror' || mode === 'mirror-only';
    const doBlur   = mode === 'blur-mirror' || mode === 'blur-only';

    const stage = document.createElement('canvas'); stage.width = outCanvas.width; stage.height = outCanvas.height;
    const sCtx = stage.getContext('2d');

    if (doMirror) {
        sCtx.drawImage(srcCanvas, B, B);
        sCtx.save(); sCtx.translate(B, B); sCtx.scale(1, -1); sCtx.drawImage(srcCanvas, 0, 0, W, B, 0, 0, W, B); sCtx.restore();
        sCtx.save(); sCtx.translate(B, B + H); sCtx.scale(1, -1); sCtx.drawImage(srcCanvas, 0, H - B, W, B, 0, -B, W, B); sCtx.restore();
        sCtx.save(); sCtx.translate(B, B); sCtx.scale(-1, 1); sCtx.drawImage(srcCanvas, 0, 0, B, H, 0, 0, B, H); sCtx.restore();
        sCtx.save(); sCtx.translate(B + W, B); sCtx.scale(-1, 1); sCtx.drawImage(srcCanvas, W - B, 0, B, H, -B, 0, B, H); sCtx.restore();
        sCtx.save(); sCtx.translate(B, B); sCtx.scale(-1, -1); sCtx.drawImage(srcCanvas, 0, 0, B, B, 0, 0, B, B); sCtx.restore();
        sCtx.save(); sCtx.translate(B + W, B); sCtx.scale(-1, -1); sCtx.drawImage(srcCanvas, W - B, 0, B, B, -B, 0, B, B); sCtx.restore();
        sCtx.save(); sCtx.translate(B, B + H); sCtx.scale(-1, -1); sCtx.drawImage(srcCanvas, 0, H - B, B, B, 0, -B, B, B); sCtx.restore();
        sCtx.save(); sCtx.translate(B + W, B + H); sCtx.scale(-1, -1); sCtx.drawImage(srcCanvas, W - B, H - B, B, B, -B, -B, B, B); sCtx.restore();
    } else {
        sCtx.drawImage(srcCanvas, 0, 0, W, 1, B, 0, W, B);
        sCtx.drawImage(srcCanvas, 0, H - 1, W, 1, B, B + H, W, B);
        sCtx.drawImage(srcCanvas, 0, 0, 1, H, 0, B, B, H);
        sCtx.drawImage(srcCanvas, W - 1, 0, 1, H, B + W, B, B, H);
        sCtx.drawImage(srcCanvas, 0, 0, 1, 1, 0, 0, B, B);
        sCtx.drawImage(srcCanvas, W - 1, 0, 1, 1, B + W, 0, B, B);
        sCtx.drawImage(srcCanvas, 0, H - 1, 1, 1, 0, B + H, B, B);
        sCtx.drawImage(srcCanvas, W - 1, H - 1, 1, 1, B + W, B + H, B, B);
        sCtx.drawImage(srcCanvas, B, B);
    }
    if (doBlur) { ctx.filter = 'blur(4px)'; ctx.drawImage(stage, 0, 0); ctx.filter = 'none'; } 
    else { ctx.drawImage(stage, 0, 0); }
    ctx.drawImage(srcCanvas, B, B);
    return outCanvas;
}

// --- CMYK BINARY MATH ALGORITHMS ---
function mirrorAndBlurCMYK(srcDataObj, bPx, mode) {
    if (!mode) mode = state.bleedMode || 'blur-mirror';
    const W = srcDataObj.width, H = srcDataObj.height, B = Math.max(0, Math.min(bPx, Math.floor(W/2)-2, Math.floor(H/2)-2));
    const destW = W + (B * 2), destH = H + (B * 2);
    const doMirror = mode === 'blur-mirror' || mode === 'mirror-only', doBlur = mode === 'blur-mirror' || mode === 'blur-only';
    const src = srcDataObj.data;
    let outData = new Uint8Array(destW * destH * 4);

    for (let y = 0; y < destH; y++) {
        for (let x = 0; x < destW; x++) {
            let sx = x - B, sy = y - B;
            if (doMirror) {
                if (sx < 0) sx = -sx - 1; else if (sx >= W) sx = W - (sx - W) - 1;
                if (sy < 0) sy = -sy - 1; else if (sy >= H) sy = H - (sy - H) - 1;
            } else {
                sx = Math.max(0, Math.min(W - 1, sx)); sy = Math.max(0, Math.min(H - 1, sy));
            }
            const srcIdx = (sy * W + sx) * 4, dstIdx = (y * destW + x) * 4;
            outData[dstIdx] = src[srcIdx]; outData[dstIdx+1] = src[srcIdx+1]; outData[dstIdx+2] = src[srcIdx+2]; outData[dstIdx+3] = src[srcIdx+3];
        }
    }

    if (B > 0 && doBlur) {
        const rad = 3, temp = new Uint8Array(outData.length);
        for (let y = 0; y < destH; y++) {
            for (let x = 0; x < destW; x++) {
                let c=0,m=0,yy=0,k=0,count=0;
                for (let r = -rad; r <= rad; r++) {
                    const nx = Math.max(0, Math.min(destW-1, x+r)), idx = (y*destW+nx)*4;
                    c+=outData[idx]; m+=outData[idx+1]; yy+=outData[idx+2]; k+=outData[idx+3]; count++;
                }
                const out=(y*destW+x)*4; temp[out]=c/count; temp[out+1]=m/count; temp[out+2]=yy/count; temp[out+3]=k/count;
            }
        }
        for (let y = 0; y < destH; y++) {
            for (let x = 0; x < destW; x++) {
                let c=0,m=0,yy=0,k=0,count=0;
                for (let r = -rad; r <= rad; r++) {
                    const ny = Math.max(0, Math.min(destH-1, y+r)), idx = (ny*destW+x)*4;
                    c+=temp[idx]; m+=temp[idx+1]; yy+=temp[idx+2]; k+=temp[idx+3]; count++;
                }
                const out=(y*destW+x)*4; outData[out]=c/count; outData[out+1]=m/count; outData[out+2]=yy/count; outData[out+3]=k/count;
            }
        }
    }
    return { data: outData, width: destW, height: destH };
}

async function buildCmykBleedPdf(fileItem, bPx, dpi) {
    const { PDFDocument } = PDFLib;
    const bleedCMYK = mirrorAndBlurCMYK(fileItem.cmykData, bPx);
    const bleedCanvas = createGhostRgbCanvas(bleedCMYK);
    const bleedJpegBlob = await new Promise(res => bleedCanvas.toBlob(res, 'image/jpeg', 0.92));
    const bleedJpegBytes = new Uint8Array(await bleedJpegBlob.arrayBuffer());
    const originalBytes = new Uint8Array(fileItem.originalBuffer);

    const totalW = bleedCMYK.width, totalH = bleedCMYK.height, origW  = fileItem.cmykData.width, origH  = fileItem.cmykData.height;
    const pageWidthPt  = (totalW / dpi) * 72, pageHeightPt = (totalH / dpi) * 72, bleedOffsetPt = (bPx / dpi) * 72;
    const origWidthPt   = (origW  / dpi) * 72, origHeightPt  = (origH  / dpi) * 72;

    const pdfDoc = await PDFDocument.create(), page = pdfDoc.addPage([pageWidthPt, pageHeightPt]);
    const bleedImg = await pdfDoc.embedJpg(bleedJpegBytes);
    page.drawImage(bleedImg, { x: 0, y: 0, width: pageWidthPt, height: pageHeightPt });
    const origImg = await pdfDoc.embedJpg(originalBytes);
    page.drawImage(origImg, { x: bleedOffsetPt, y: bleedOffsetPt, width: origWidthPt, height: origHeightPt });
    return pdfDoc.save(); 
}

async function buildPantoneBleedPdf(fileItem, bPx, dpi) {
    const { PDFDocument } = PDFLib;
    const bleedCanvas = generateRGBBleedCanvas(fileItem.canvas, bPx);
    const bleedJpegBlob  = await new Promise(res => bleedCanvas.toBlob(res, 'image/jpeg', 0.92));
    const bleedJpegBytes = new Uint8Array(await bleedJpegBlob.arrayBuffer());

    const totalW = bleedCanvas.width, totalH = bleedCanvas.height, origW  = fileItem.canvas.width, origH  = fileItem.canvas.height;
    const pageWidthPt   = (totalW / dpi) * 72, pageHeightPt  = (totalH / dpi) * 72, bleedOffsetPt = (bPx / dpi) * 72;
    const origWidthPt   = (origW  / dpi) * 72, origHeightPt  = (origH  / dpi) * 72;

    const srcDoc  = await PDFDocument.load(fileItem.originalBuffer, { ignoreEncryption: true });
    const outDoc  = await PDFDocument.create(), page = outDoc.addPage([pageWidthPt, pageHeightPt]);

    const bleedImg = await outDoc.embedJpg(bleedJpegBytes);
    page.drawImage(bleedImg, { x: 0, y: 0, width: pageWidthPt, height: pageHeightPt });
    const [embeddedPage] = await outDoc.embedPdf(srcDoc, [fileItem.pageIndex]);
    page.drawPage(embeddedPage, { x: bleedOffsetPt, y: bleedOffsetPt, width: origWidthPt, height: origHeightPt });
    return outDoc.save();
}

function createGhostRgbCanvas(cmykObj) {
    const canvas = document.createElement('canvas'); canvas.width = cmykObj.width; canvas.height = cmykObj.height;
    const ctx = canvas.getContext('2d'), imgData = ctx.createImageData(cmykObj.width, cmykObj.height);
    for (let i = 0; i < cmykObj.data.length; i += 4) {
        let c = cmykObj.data[i] / 255, m = cmykObj.data[i+1] / 255, y = cmykObj.data[i+2] / 255, k = cmykObj.data[i+3] / 255;
        imgData.data[i] = 255 * (1 - c) * (1 - k);
        imgData.data[i+1] = 255 * (1 - m) * (1 - k);
        imgData.data[i+2] = 255 * (1 - y) * (1 - k);
        imgData.data[i+3] = 255;
    }
    ctx.putImageData(imgData, 0, 0); return canvas;
}

// --- VIEW CONTROLLER ---
async function recalculateAndRender() {
    previewContainer.innerHTML = '';
    const bPx = calculateBleedInPixels();

    for (const fileItem of state.files) {
        const card = document.createElement('div'); card.className = 'preview-card';
        let displayWidthIn, displayHeightIn, displayCanvas, innerWidth, innerHeight;
        
        if (fileItem.type === 'rgb' || fileItem.type === 'pantone' || fileItem.type === 'pdf-cmyk') {
            const bledCanvas = generateRGBBleedCanvas(fileItem.canvas, bPx);
            displayCanvas   = bledCanvas;
            displayWidthIn  = (bledCanvas.width  / state.dpi).toFixed(3); displayHeightIn = (bledCanvas.height / state.dpi).toFixed(3);
            innerWidth  = fileItem.canvas.width; innerHeight = fileItem.canvas.height;
        } else {
            const processedCMYK = mirrorAndBlurCMYK(fileItem.cmykData, bPx);
            displayCanvas   = createGhostRgbCanvas(processedCMYK);
            displayWidthIn  = (processedCMYK.width  / state.dpi).toFixed(3); displayHeightIn = (processedCMYK.height / state.dpi).toFixed(3);
            innerWidth  = fileItem.cmykData.width; innerHeight = fileItem.cmykData.height;
        }

        let modeBadge;
        if (fileItem.type === 'cmyk') modeBadge = `<span class="badge badge-cmyk">CMYK RAW</span>`;
        else if (fileItem.type === 'pdf-cmyk') modeBadge = `<span class="badge badge-cmyk">PDF CMYK</span>`;
        else if (fileItem.type === 'pantone') {
            const tipNames = fileItem.pantoneSpots.map(s => s.name).join(', '), shortLabel = fileItem.pantoneSpots.length === 1 ? fileItem.pantoneSpots[0].name : `${fileItem.pantoneSpots.length} Spot Colors`;
            modeBadge = `<span class="badge badge-pantone" title="${tipNames}">🎨 ${shortLabel}</span>`;
        } else modeBadge = `<span class="badge badge-rgb">RGB</span>`;

        const cardHeader = document.createElement('div'); cardHeader.className = 'card-header';
        cardHeader.innerHTML = `<div class="card-title" title="${fileItem.name}">${fileItem.name}</div><div class="card-dims">${modeBadge} ${displayWidthIn}" x ${displayHeightIn}"</div>`;

        const canvasWrapper = document.createElement('div'); canvasWrapper.className = 'canvas-wrapper';
        const leftPct = (bPx / displayCanvas.width) * 100, topPct = (bPx / displayCanvas.height) * 100, widthPct = (innerWidth / displayCanvas.width) * 100, heightPct = (innerHeight / displayCanvas.height) * 100;
        const guideOverlay = document.createElement('div'); guideOverlay.className = 'trim-guide';
        guideOverlay.style.left = `${leftPct}%`; guideOverlay.style.top = `${topPct}%`; guideOverlay.style.width = `${widthPct}%`; guideOverlay.style.height = `${heightPct}%`; guideOverlay.style.display = state.showGuides ? 'block' : 'none';

        const clickHint = document.createElement('div'); clickHint.className = 'canvas-click-hint'; clickHint.textContent = 'Click to inspect channels';

        canvasWrapper.appendChild(displayCanvas); canvasWrapper.appendChild(guideOverlay); canvasWrapper.appendChild(clickHint);
        canvasWrapper.style.cursor = 'pointer'; canvasWrapper.addEventListener('click', () => openChannelViewer(fileItem));
        card.appendChild(cardHeader); card.appendChild(canvasWrapper); previewContainer.appendChild(card);
        
        await new Promise(r => setTimeout(r, 10));
    }
}

// ═══════════════════════════════════════════════════════════════
// CHANNEL VIEWER & SPOT PLATE EXPORT
// ═══════════════════════════════════════════════════════════════

function extractChannelData(fileItem) {
    if (fileItem.type === 'cmyk') return { mode: 'cmyk', width: fileItem.cmykData.width, height: fileItem.cmykData.height, data: fileItem.cmykData.data.slice() };
    const src = fileItem.canvas, ctx = src.getContext('2d'), rgba = ctx.getImageData(0, 0, src.width, src.height).data;
    if (fileItem.type === 'rgb') return { mode: 'rgb', width: src.width, height: src.height, data: rgba };

    const cmyk = new Uint8Array(rgba.length);
    for (let i = 0; i < rgba.length; i += 4) {
        const r = rgba[i]/255, g = rgba[i+1]/255, b = rgba[i+2]/255, k = 1 - Math.max(r, g, b), d = (1 - k) || 1e-6;
        cmyk[i]   = Math.round(((1-r-k)/d)*255); cmyk[i+1] = Math.round(((1-g-k)/d)*255); cmyk[i+2] = Math.round(((1-b-k)/d)*255); cmyk[i+3] = Math.round(k*255);
    }
    return { mode: 'cmyk', width: src.width, height: src.height, data: cmyk };
}

function getChannels(fileItem) {
    if (fileItem.type === 'rgb') return [
        { id: 'R', label: 'Red', colorHint: '#ef4444', channelIndex: 0 }, { id: 'G', label: 'Green', colorHint: '#22c55e', channelIndex: 1 },
        { id: 'B', label: 'Blue', colorHint: '#3b82f6', channelIndex: 2 }, { id: 'A', label: 'Alpha', colorHint: '#9ca3af', channelIndex: 3 }
    ];
    const channels = [
        { id: 'C', label: 'Cyan', colorHint: '#06b6d4', channelIndex: 0 }, { id: 'M', label: 'Magenta', colorHint: '#ec4899', channelIndex: 1 },
        { id: 'Y', label: 'Yellow', colorHint: '#eab308', channelIndex: 2 }, { id: 'K', label: 'Black', colorHint: '#6b7280', channelIndex: 3 }
    ];
    if (fileItem.type === 'pantone' && fileItem.pantoneSpots) {
        fileItem.pantoneSpots.forEach((spot, i) => channels.push({ id: `SPOT_${i}`, label: spot.name, colorHint: '#7b2d8b', channelIndex: -1, spotCmyk: spot }));
    }
    return channels;
}

// ── PDF-Lib Native Separation PDF Generation ──────────────────
// Process channels (C/M/Y/K) are rebuilt as DUOTONE plates: a pure white-to-single-ink
// ramp for that one channel only (no blending in the other three process inks).
// Pantone spot channels keep the original multi-component spot-plate behavior.
//
// IMPORTANT: we do NOT use pdfDoc.embedPng() here. pdf-lib embeds PNG images lazily —
// the actual /Image XObject isn't materialized in the PDF context until .save() runs,
// so any attempt to look up and mutate its /ColorSpace beforehand is a no-op, and the
// image silently keeps PNG's default DeviceGray. Instead we build the Image XObject's
// dictionary ourselves, with /ColorSpace set to our /Separation space from the moment
// the object is created, so the ink color is guaranteed to stick.
async function generateSpotPlatePDF(ch, width, height, px, dpi) {
    const { PDFDocument, PDFName } = PDFLib;
    const samples = new Uint8Array(width * height);

    let c = 0, m = 0, y = 0, k = 0, spotName = ch.label;
    const isDuotone = ch.channelIndex >= 0;

    if (isDuotone) {
        const ci = ch.channelIndex;
        // Invert for solid PDF structure: 255 = paper (0%), 0 = full solid ink (100%)
        for (let p = 0; p < width * height; p++) samples[p] = 255 - px[p * 4 + ci];
        // Duotone: isolate this single ink only — no cross-blend with the other process inks
        if (ci === 0) c = 1; else if (ci === 1) m = 1; else if (ci === 2) y = 1; else if (ci === 3) k = 1;
        spotName = `${ch.label}_Duotone`;
    } else {
        const sc = ch.spotCmyk;
        c = sc.C; m = sc.M; y = sc.Y; k = sc.K;
        const mag = Math.sqrt(c*c + m*m + y*y + k*k) || 1;
        for (let p = 0; p < width * height; p++) {
            const i = p * 4, density = Math.min(1, Math.max(0, (px[i]/255*c + px[i+1]/255*m + px[i+2]/255*y + px[i+3]/255*k) / mag));
            samples[p] = 255 - Math.round(density * 255);
        }
    }

    const pdfDoc = await PDFDocument.create();

    // Single-ink duotone ramp (white → 100% of this one ink), or full spot-plate tint for Pantone spots
    const tintFunc = pdfDoc.context.obj({ FunctionType: 2, Domain: [0, 1], Range: [0, 1, 0, 1, 0, 1, 0, 1], C0: [0, 0, 0, 0], C1: [c, m, y, k], N: 1 });
    const safeSpotName = spotName.replace(/[\s/()]+/g, '_');
    const sepSpace = pdfDoc.context.obj([ PDFName.of('Separation'), PDFName.of(safeSpotName), PDFName.of('DeviceCMYK'), tintFunc ]);

    // Compress the raw single-channel 8-bit sample buffer directly (no PNG framing needed —
    // we're building the /Image stream by hand, so FlateDecode on the raw bytes is enough).
    const compressed = await deflateRaw(samples);

    const imgRef = pdfDoc.context.register(
        pdfDoc.context.stream(compressed, {
            Type: 'XObject',
            Subtype: 'Image',
            Width: width,
            Height: height,
            BitsPerComponent: 8,
            ColorSpace: sepSpace,
            Filter: 'FlateDecode',
            // [1, 0] Decode because 0 in our samples is full ink, 255 is clean white paper.
            Decode: pdfDoc.context.obj([1, 0]),
        })
    );

    const widthPt = (width / dpi) * 72, heightPt = (height / dpi) * 72;
    const page = pdfDoc.addPage([widthPt, heightPt]);

    const xObjName = page.node.newXObject('Img', imgRef);
    const opName = xObjName.encodedName || `/${xObjName}`;
    const contentBytes = await deflateRaw(new TextEncoder().encode(`q ${widthPt} 0 0 ${heightPt} 0 0 cm ${opName} Do Q`));
    const contentRef = pdfDoc.context.register(
        pdfDoc.context.stream(contentBytes, { Filter: 'FlateDecode' })
    );
    page.node.set(PDFName.of('Contents'), contentRef);

    return await pdfDoc.save();
}

async function prerenderChannelPlates(channelData, channels, fileItem) {
    const { width, height, data, mode } = channelData;
    const px = (fileItem.type === 'cmyk') ? fileItem.cmykData.data : data;
    const plates = new Map();

    // Mathematically pre-render exactly what the viewer needs to preview channels rapidly.
    const compCanvas = document.createElement('canvas'); compCanvas.width = width; compCanvas.height = height;
    const compCtx = compCanvas.getContext('2d'), compImg = compCtx.createImageData(width, height), cd = compImg.data;
    if (mode === 'rgb') {
        for (let i = 0; i < px.length; i += 4) { cd[i] = px[i]; cd[i+1] = px[i+1]; cd[i+2] = px[i+2]; cd[i+3] = px[i+3]; }
    } else {
        const spotChannels = channels.filter(ch => ch.spotCmyk);
        for (let i = 0; i < px.length; i += 4) {
            let c = px[i]/255, m = px[i+1]/255, y = px[i+2]/255, k = px[i+3]/255;
            for (const spot of spotChannels) {
                const sc = spot.spotCmyk, mag = Math.sqrt(sc.C*sc.C + sc.M*sc.M + sc.Y*sc.Y + sc.K*sc.K) || 1;
                const density = Math.min(1, Math.max(0, (px[i]/255*sc.C + px[i+1]/255*sc.M + px[i+2]/255*sc.Y + px[i+3]/255*sc.K) / mag));
                c = Math.min(1, c + sc.C*density); m = Math.min(1, m + sc.M*density); y = Math.min(1, y + sc.Y*density); k = Math.min(1, k + sc.K*density);
            }
            cd[i] = Math.round(255*(1-c)*(1-k)); cd[i+1] = Math.round(255*(1-m)*(1-k)); cd[i+2] = Math.round(255*(1-y)*(1-k)); cd[i+3] = 255;
        }
    }
    compCtx.putImageData(compImg, 0, 0); plates.set('composite', { canvas: compCanvas });

    // Loop through individual plates mathematically (Bypasses pdf.js completely for the UI viewer)
    for (const ch of channels) {
        const cv = document.createElement('canvas'); cv.width = width; cv.height = height;
        const ctx = cv.getContext('2d'), img = ctx.createImageData(width, height), od = img.data;

        if (mode === 'rgb') {
            const ci = ch.channelIndex;
            for (let i = 0; i < px.length; i += 4) { 
                od[i] = ci===0?px[i]:0; od[i+1] = ci===1?px[i+1]:0; od[i+2] = ci===2?px[i+2]:0; od[i+3] = ci===3?px[i+3]:255; 
            }
        } else if (ch.channelIndex >= 0 || ch.spotCmyk) {
            let c = 0, m = 0, y = 0, k = 0;
            if (ch.channelIndex >= 0) {
                const ci = ch.channelIndex;
                if (ci === 0) c = 1; else if (ci === 1) m = 1; else if (ci === 2) y = 1; else if (ci === 3) k = 1;
                for (let p = 0; p < width * height; p++) {
                    const i = p * 4, ink = px[i + ci] / 255;
                    od[i] = Math.round(255*(1-c*ink)); od[i+1] = Math.round(255*(1-m*ink)); od[i+2] = Math.round(255*(1-y*ink)); od[i+3] = 255;
                }
            } else {
                const sc = ch.spotCmyk; c = sc.C; m = sc.M; y = sc.Y; k = sc.K;
                const mag = Math.sqrt(c*c + m*m + y*y + k*k) || 1;
                for (let p = 0; p < width * height; p++) {
                    const i = p * 4;
                    const density = Math.min(1, Math.max(0, (px[i]/255*c + px[i+1]/255*m + px[i+2]/255*y + px[i+3]/255*k) / mag));
                    od[i] = Math.round(255*(1-c*density)); od[i+1] = Math.round(255*(1-m*density)); od[i+2] = Math.round(255*(1-y*density)); od[i+3] = 255;
                }
            }
        }
        ctx.putImageData(img, 0, 0); plates.set(ch.id, { canvas: cv });
    }
    return plates;
}

async function downloadSpotPlatePdf(ch, fileItem, channelData) {
    const isDuotone = ch.channelIndex >= 0;
    showLoading(isDuotone ? "Generating Duotone Plate" : "Generating Spot Plate", isDuotone ? "Building white-to-ink duotone PDF..." : "Building raw PDF separation...");
    try {
        const cleanName = fileItem.name.replace(/\.[^/.]+$/, '');
        const px = (fileItem.type === 'cmyk') ? fileItem.cmykData.data : channelData.data;

        const pdfBytes = await generateSpotPlatePDF(ch, channelData.width, channelData.height, px, state.dpi);
        const safeName = ch.label.replace(/[\s/]+/g, '_'), suffix = ch.spotCmyk ? '_spot_plate' : '_duotone';

        const blob = new Blob([pdfBytes], { type: 'application/pdf' });
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
        a.download = `${cleanName}_${safeName}${suffix}.pdf`;
        a.click(); URL.revokeObjectURL(a.href);
    } catch(e) { console.error(e); alert(isDuotone ? "Failed to download duotone plate." : "Failed to download spot plate."); } 
    finally { hideLoading(); }
}

async function deflateRaw(raw) {
    if (typeof CompressionStream !== 'undefined') {
        const cs = new CompressionStream('deflate'), writer = cs.writable.getWriter();
        writer.write(raw); writer.close();
        const chunks = [], reader = cs.readable.getReader();
        while (true) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); }
        const total = chunks.reduce((s, c) => s + c.length, 0);
        const out = new Uint8Array(total);
        let off = 0; for (const c of chunks) { out.set(c, off); off += c.length; }
        return out;
    }
    return zlibStoreBlock(raw);
}

async function encodeGrayscalePNG(samples, width, height) {
    const sig = new Uint8Array([137,80,78,71,13,10,26,10]), ihdrData = new Uint8Array(13), ihdrView = new DataView(ihdrData.buffer);
    ihdrView.setUint32(0, width, false); ihdrView.setUint32(4, height, false);
    ihdrData[8] = 8; ihdrData[9] = 0; ihdrData[10] = 0; ihdrData[11] = 0; ihdrData[12] = 0;
    const ihdr = pngChunk(0x49484452, ihdrData);

    const raw = new Uint8Array(height * (width + 1));
    for (let y = 0; y < height; y++) {
        raw[y * (width + 1)] = 0;
        raw.set(samples.subarray(y * width, y * width + width), y * (width + 1) + 1);
    }

    let compressed;
    if (typeof CompressionStream !== 'undefined') {
        const cs = new CompressionStream('deflate'), writer = cs.writable.getWriter();
        writer.write(raw); writer.close();
        const chunks = [], reader = cs.readable.getReader();
        while (true) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); }
        const total = chunks.reduce((s, c) => s + c.length, 0);
        compressed = new Uint8Array(total);
        let off = 0; for (const c of chunks) { compressed.set(c, off); off += c.length; }
    } else compressed = zlibStoreBlock(raw);

    const idat = pngChunk(0x49444154, compressed), iend = pngChunk(0x49454E44, new Uint8Array(0));
    const total = sig.length + ihdr.length + idat.length + iend.length;
    const out = new Uint8Array(total);
    let off = 0; for (const part of [sig, ihdr, idat, iend]) { out.set(part, off); off += part.length; }
    return out;
}

function pngChunk(typeInt, data) {
    const buf = new Uint8Array(4 + 4 + data.length + 4), view = new DataView(buf.buffer);
    view.setUint32(0, data.length, false); view.setUint32(4, typeInt, false); buf.set(data, 8);
    const crc = crc32(buf.subarray(4, 8 + data.length)); view.setUint32(8 + data.length, crc, false);
    return buf;
}

function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) {
        c ^= buf[i];
        for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
}

function zlibStoreBlock(raw) {
    const CMF = 0x78, FLG = 0x01, BSIZE = 65535, blocks = Math.ceil(raw.length / BSIZE) || 1;
    const out = new Uint8Array(2 + blocks * 5 + raw.length + 4); let op = 0;
    out[op++] = CMF; out[op++] = FLG;
    let remaining = raw.length, ip = 0;
    for (let b = 0; b < blocks; b++) {
        const blen = Math.min(BSIZE, remaining), last = (b === blocks - 1) ? 1 : 0;
        out[op++] = last; out[op++] = blen & 0xFF; out[op++] = (blen >> 8) & 0xFF;
        out[op++] = (~blen) & 0xFF; out[op++] = ((~blen) >> 8) & 0xFF;
        out.set(raw.subarray(ip, ip + blen), op); op += blen; ip += blen; remaining -= blen;
    }
    let s1 = 1, s2 = 0;
    for (let i = 0; i < raw.length; i++) { s1 = (s1 + raw[i]) % 65521; s2 = (s2 + s1) % 65521; }
    const adler = (s2 << 16) | s1;
    out[op++] = (adler >>> 24) & 0xFF; out[op++] = (adler >>> 16) & 0xFF; out[op++] = (adler >>> 8)  & 0xFF; out[op++] = adler & 0xFF;
    return out.subarray(0, op);
}

function blitActiveChannels(activeIds, channels, plates, modalCanvas) {
    const ctx = modalCanvas.getContext('2d'), { width, height } = modalCanvas, activeArr = [...activeIds];
    if (activeArr.length === 0) { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, width, height); return; }

    if (activeArr.length === channels.length) {
        const comp = plates.get('composite'); if (comp) { ctx.drawImage(comp.canvas, 0, 0); return; }
    }
    if (activeArr.length === 1) {
        const plate = plates.get(activeArr[0]); if (plate) { ctx.drawImage(plate.canvas, 0, 0); return; }
    }

    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, width, height);
    ctx.globalCompositeOperation = 'multiply';
    for (const id of activeArr) { const plate = plates.get(id); if (plate) ctx.drawImage(plate.canvas, 0, 0); }
    ctx.globalCompositeOperation = 'source-over';
}

async function openChannelViewer(fileItem) {
    showLoading("Generating Spot Plates", "Compiling internal plate maps mathematically...");
    try {
        const modal = document.getElementById('channelModal'), modalTitle = document.getElementById('channelModalTitle'),
              channelNav = document.getElementById('channelNav'), modalCanvas = document.getElementById('channelModalCanvas');

        const channelData = extractChannelData(fileItem), channels = getChannels(fileItem);
        modalTitle.textContent = fileItem.name; modalCanvas.width = channelData.width; modalCanvas.height = channelData.height;

        const plates = await prerenderChannelPlates(channelData, channels, fileItem);
        const activeChannels = new Set(channels.map(c => c.id));
        channelNav.innerHTML = '';

        const compositeBtn = document.createElement('button'); compositeBtn.className = 'ch-pill ch-pill-composite active'; compositeBtn.textContent = 'Composite';
        compositeBtn.addEventListener('click', () => {
            if (channels.every(c => activeChannels.has(c.id))) { activeChannels.clear(); compositeBtn.classList.remove('active'); } 
            else { channels.forEach(c => activeChannels.add(c.id)); compositeBtn.classList.add('active'); }
            updatePills(); redrawModal();
        });
        channelNav.appendChild(compositeBtn);
        const sep = document.createElement('div'); sep.className = 'ch-sep'; channelNav.appendChild(sep);

        channels.forEach(ch => {
            const pill = document.createElement('button'); pill.className = 'ch-pill active'; pill.style.setProperty('--ch-color', ch.colorHint); pill.dataset.chId = ch.id;
            const dot = document.createElement('span'); dot.className = 'ch-dot';
            const lbl = document.createElement('span'); lbl.textContent = ch.id.startsWith('SPOT_') ? ch.label : `${ch.label} (${ch.id})`;

            const dlBtn = document.createElement('button'); dlBtn.className = 'ch-dl-btn'; dlBtn.title = `Download ${ch.label} channel`;
            dlBtn.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 2v8M5 7l3 3 3-3M3 13h10"/></svg>`;
            dlBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (ch.channelIndex >= 0 || ch.spotCmyk) {
                    await downloadSpotPlatePdf(ch, fileItem, channelData);
                } else {
                    const plateWrap = plates.get(ch.id); if (!plateWrap || !plateWrap.canvas) return;
                    plateWrap.canvas.toBlob(blob => {
                        const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
                        a.download = `${fileItem.name.replace(/\.[^/.]+$/, '')}_${ch.label.replace(/[\s/]+/g, '_')}_channel.png`;
                        a.click(); URL.revokeObjectURL(a.href);
                    }, 'image/png');
                }
            });

            pill.appendChild(dot); pill.appendChild(lbl); pill.appendChild(dlBtn);
            pill.addEventListener('click', () => {
                if (activeChannels.has(ch.id)) { activeChannels.delete(ch.id); pill.classList.remove('active'); } 
                else { activeChannels.add(ch.id); pill.classList.add('active'); }
                updateCompositeBtn(); redrawModal();
            });
            channelNav.appendChild(pill);
        });

        function updatePills() { channelNav.querySelectorAll('.ch-pill[data-ch-id]').forEach(pill => pill.classList.toggle('active', activeChannels.has(pill.dataset.chId))); }
        function updateCompositeBtn() { compositeBtn.classList.toggle('active', channels.every(c => activeChannels.has(c.id))); }
        function redrawModal() { blitActiveChannels(activeChannels, channels, plates, modalCanvas); }

        redrawModal(); hideLoading(); modal.classList.add('open');
    } catch(err) { hideLoading(); console.error(err); alert("Error opening channel viewer: " + err.message); }
}

function closeChannelModal() { document.getElementById('channelModal').classList.remove('open'); }
function toggleGuideVisibility() { document.querySelectorAll('.trim-guide').forEach(g => g.style.display = state.showGuides ? 'block' : 'none'); }
function resetApplicationState() { state.files = []; previewContainer.innerHTML = ''; fileInput.value = ''; workspace.style.display = 'none'; dropZone.style.display = 'block'; }

function encodeToCMYK_TIFF(cmykDataObj, dpi) {
    const { width, height, data } = cmykDataObj, pixelBytes = width * height * 4;
    const BPS_OFFSET = 158, XRES_OFFSET = 166, YRES_OFFSET = 174, DATA_OFFSET = 182;
    const buffer = new ArrayBuffer(DATA_OFFSET + pixelBytes), view = new DataView(buffer);
    view.setUint16(0, 0x4949, true); view.setUint16(2, 42, true); view.setUint32(4, 8, true); view.setUint16(8, 12, true); 
    let ptr = 10;
    const addTag = (tag, type, count, valOrOffset) => { view.setUint16(ptr, tag, true); view.setUint16(ptr + 2, type, true); view.setUint32(ptr + 4, count, true); view.setUint32(ptr + 8, valOrOffset, true); ptr += 12; };

    addTag(256, 4, 1, width); addTag(257, 4, 1, height); addTag(258, 3, 4, BPS_OFFSET); addTag(259, 3, 1, 1); addTag(262, 3, 1, 5); addTag(273, 4, 1, DATA_OFFSET); addTag(277, 3, 1, 4); addTag(278, 4, 1, height); addTag(279, 4, 1, pixelBytes); addTag(282, 5, 1, XRES_OFFSET); addTag(283, 5, 1, YRES_OFFSET); addTag(296, 3, 1, 2); 
    view.setUint32(ptr, 0, true);
    view.setUint16(BPS_OFFSET, 8, true); view.setUint16(BPS_OFFSET + 2, 8, true); view.setUint16(BPS_OFFSET + 4, 8, true); view.setUint16(BPS_OFFSET + 6, 8, true);
    view.setUint32(XRES_OFFSET, dpi, true); view.setUint32(XRES_OFFSET + 4, 1, true); view.setUint32(YRES_OFFSET, dpi, true); view.setUint32(YRES_OFFSET + 4, 1, true);
    new Uint8Array(buffer, DATA_OFFSET).set(data); return new Blob([buffer], { type: 'image/tiff' });
}

function injectPhysicalDpiMetadata(blobInstance, targetDpiValue) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = function(event) {
            const fileBytes = new Uint8Array(event.target.result), ppm = Math.round(targetDpiValue / 0.0254);
            const blockData = new Uint8Array(9);
            blockData[0] = (ppm >>> 24) & 0xFF; blockData[1] = (ppm >>> 16) & 0xFF; blockData[2] = (ppm >>> 8) & 0xFF; blockData[3] = ppm & 0xFF;
            blockData[4] = (ppm >>> 24) & 0xFF; blockData[5] = (ppm >>> 16) & 0xFF; blockData[6] = (ppm >>> 8) & 0xFF; blockData[7] = ppm & 0xFF;
            blockData[8] = 0x01; 
            const blockType = new Uint8Array([112, 72, 89, 115]), combinedBuffer = new Uint8Array(blockType.length + blockData.length);
            combinedBuffer.set(blockType, 0); combinedBuffer.set(blockData, blockType.length);
            
            let c, crcTable = [];
            for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) { c = ((c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)); } crcTable[n] = c; }
            let runningCrc = 0xFFFFFFFF;
            for (let i = 0; i < combinedBuffer.length; i++) { runningCrc = (runningCrc >>> 8) ^ crcTable[(runningCrc ^ combinedBuffer[i]) & 0xFF]; }
            const finalChecksum = (runningCrc ^ 0xFFFFFFFF) >>> 0;
            
            const entireChunk = new Uint8Array(4 + 4 + 9 + 4); entireChunk[3] = 9;
            entireChunk.set(blockType, 4); entireChunk.set(blockData, 8);
            entireChunk[17] = (finalChecksum >>> 24) & 0xFF; entireChunk[18] = (finalChecksum >>> 16) & 0xFF; entireChunk[19] = (finalChecksum >>> 8) & 0xFF; entireChunk[20] = finalChecksum & 0xFF;
            
            const updatedFileStream = new Uint8Array(fileBytes.length + entireChunk.length);
            updatedFileStream.set(fileBytes.subarray(0, 33), 0); updatedFileStream.set(entireChunk, 33); updatedFileStream.set(fileBytes.subarray(33), 33 + entireChunk.length);
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
        const { PDFDocument } = PDFLib, bPx = calculateBleedInPixels(), masterDoc = await PDFDocument.create();

        for (let i = 0; i < state.files.length; i++) {
            const fileItem = state.files[i]; await new Promise(r => setTimeout(r, 10)); 

            if (fileItem.type === 'rgb') {
                const bleedCanvas = generateRGBBleedCanvas(fileItem.canvas, bPx), jpegBlob = await new Promise(res => bleedCanvas.toBlob(res, 'image/jpeg', 0.92)), jpegBytes = new Uint8Array(await jpegBlob.arrayBuffer());
                const widthPt  = (bleedCanvas.width  / state.dpi) * 72, heightPt = (bleedCanvas.height / state.dpi) * 72;
                const img  = await masterDoc.embedJpg(jpegBytes), page = masterDoc.addPage([widthPt, heightPt]);
                page.drawImage(img, { x: 0, y: 0, width: widthPt, height: heightPt });
            } else if (fileItem.type === 'pantone' || fileItem.type === 'pdf-cmyk') {
                const pdfBytes = await buildPantoneBleedPdf(fileItem, bPx, state.dpi), srcDoc = await PDFDocument.load(pdfBytes), [copiedPage] = await masterDoc.copyPages(srcDoc, [0]);
                masterDoc.addPage(copiedPage);
            } else {
                const cmykPdfBytes = await buildCmykBleedPdf(fileItem, bPx, state.dpi), cmykDoc = await PDFDocument.load(cmykPdfBytes), [copiedPage] = await masterDoc.copyPages(cmykDoc, [0]);
                masterDoc.addPage(copiedPage);
            }
        }
        const pdfBytes = await masterDoc.save(), blob = new Blob([pdfBytes], { type: 'application/pdf' }), a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = 'press_ready_proof.pdf'; a.click(); URL.revokeObjectURL(a.href);
    } catch (ex) { alert(`Export failed: ${ex.message}`); } finally { hideLoading(); }
}

async function exportSlicesAsZIP() {
    if (state.files.length === 0) return;
    showLoading("ZIP Compression", "Exporting print-ready files with CMYK preservation...");
    await new Promise(resolve => setTimeout(resolve, 50));

    try {
        const zipEngine = new JSZip(), bPx = calculateBleedInPixels();
        for (let i = 0; i < state.files.length; i++) {
            const item = state.files[i]; let cleanName = item.name.replace(/\.[^/.]+$/, "");
            if (item.type === 'rgb') {
                const outCnv = generateRGBBleedCanvas(item.canvas, bPx), blob = await new Promise(res => outCnv.toBlob(res, 'image/png')), dpiBlob = await injectPhysicalDpiMetadata(blob, state.dpi);
                zipEngine.file(`${cleanName}_bleed_rgb_${i + 1}.png`, dpiBlob);
            } else if (item.type === 'pantone') {
                const pantPdfBytes = await buildPantoneBleedPdf(item, bPx, state.dpi); zipEngine.file(`${cleanName}_bleed_pantone_${i + 1}.pdf`, pantPdfBytes);
            } else if (item.type === 'pdf-cmyk') {
                const pdfCmykBytes = await buildPantoneBleedPdf(item, bPx, state.dpi); zipEngine.file(`${cleanName}_bleed_cmyk_${i + 1}.pdf`, pdfCmykBytes);
            } else {
                const bleedCMYK = mirrorAndBlurCMYK(item.cmykData, bPx), src = item.cmykData.data, W = item.cmykData.width, H = item.cmykData.height, B = Math.max(0, Math.min(bPx, Math.floor(W/2)-2, Math.floor(H/2)-2)), dW = bleedCMYK.width;
                for (let y = 0; y < H; y++) {
                    for (let x = 0; x < W; x++) {
                        const sIdx = (y * W + x) * 4, dIdx = ((y + B) * dW + (x + B)) * 4;
                        bleedCMYK.data[dIdx] = src[sIdx]; bleedCMYK.data[dIdx+1] = src[sIdx+1]; bleedCMYK.data[dIdx+2] = src[sIdx+2]; bleedCMYK.data[dIdx+3] = src[sIdx+3];
                    }
                }
                const tiffBlob = encodeToCMYK_TIFF(bleedCMYK, state.dpi); zipEngine.file(`${cleanName}_bleed_cmyk_${i + 1}.tiff`, tiffBlob);
                const cmykPdfBytes = await buildCmykBleedPdf(item, bPx, state.dpi); zipEngine.file(`${cleanName}_bleed_cmyk_${i + 1}.pdf`, cmykPdfBytes);
            }
            await new Promise(r => setTimeout(r, 10));
        }
        const zipContent = await zipEngine.generateAsync({ type: "blob" }), a = document.createElement('a');
        a.href = URL.createObjectURL(zipContent); a.download = "press_ready_files.zip"; a.click(); URL.revokeObjectURL(a.href);
    } catch (ex) { alert(`Archive crashed: ${ex.message}`); } finally { hideLoading(); }
}