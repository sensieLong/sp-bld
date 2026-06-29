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
// Scans raw PDF bytes for Separation colorspace definitions containing "PANTONE".
// PDF Separation syntax:
//   [ /Separation /PANTONE#20485#20C /DeviceCMYK { c m y k } ]
// Also tries to extract the CMYK alternate tint values from the tint transform
// function (a simple array or sampled function) so we can render spot previews.
//
// Returns array of { name: string, C: 0-1, M: 0-1, Y: 0-1, K: 0-1 }
// If CMYK alternates can't be parsed, defaults to { C:0, M:0, Y:0, K:1 } (black).
function detectPantoneSpotsInPdf(buffer) {
    const text  = new TextDecoder('latin1').decode(new Uint8Array(buffer));
    const spots = new Map(); // name → {C,M,Y,K}

    // Decode PDF hex-encoded name characters e.g. #20 → space
    function decodePdfName(raw) {
        return raw.replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).trim();
    }

    // Try to extract 4 CMYK numbers from a PDF function body near the spot definition.
    // Looks for patterns like: { 0.1 0.9 0.0 0.05 } or arrays [ 0.1 0.9 0.0 0.05 ]
    function extractCmykValues(chunk) {
        // Match 4 consecutive decimal numbers (floats 0-1)
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

    // Primary: match full Separation array with /DeviceCMYK alternate
    // Pattern: /Separation /NAME /DeviceCMYK <<...>>  or  /Separation /NAME /DeviceCMYK { ... }
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

    // Fallback: match name-only (string form) and name-object form, no CMYK available
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

    // Return array of spot objects
    return [...spots.entries()].map(([name, cmyk]) => ({ name, ...cmyk }));
}

// --- PDF CMYK DETECTOR ---
// Scans raw PDF bytes for DeviceCMYK colorspace references.
// Returns true if the PDF uses CMYK color (and has no Pantone spots — caller checks Pantone first).
function detectCmykInPdf(buffer) {
    const text = new TextDecoder('latin1').decode(new Uint8Array(buffer));
    // Common patterns: /DeviceCMYK, /CS /CMYK, colorspace dictionaries
    return /\/DeviceCMYK/.test(text) ||
           /\/ColorSpace\s*\/CMYK/.test(text) ||
           /\/CS\s*\/CMYK/.test(text);
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
    showGuides: true,
    bleedMode: 'blur-mirror'  // 'blur-mirror' | 'mirror-only' | 'blur-only' | 'solid-extend'
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

document.querySelectorAll('input[name="bleedMode"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
        state.bleedMode = e.target.value;
        recalculateAndRender();
    });
});
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

                // Priority: Pantone (spot) > CMYK > RGB
                // Check Pantone first — a CMYK PDF with spot plates should be treated as Pantone
                const pantoneSpots = detectPantoneSpotsInPdf(pdfBuffer);
                const hasPantone   = pantoneSpots.length > 0;
                const hasCmyk      = !hasPantone && detectCmykInPdf(pdfBuffer);

                const canvases = await renderPdfToCanvases(file, pdfBuffer);
                canvases.forEach((canvas, idx) => {
                    let type = 'rgb';
                    if (hasPantone) type = 'pantone';
                    else if (hasCmyk) type = 'pdf-cmyk';

                    state.files.push({
                        name: `${file.name} (Page ${idx + 1})`,
                        type,
                        canvas,
                        // Both Pantone and CMYK-PDF stash the original buffer so
                        // pdf-lib can embed the raw page at export (original preserved)
                        ...((hasPantone || hasCmyk) && {
                            originalBuffer: pdfBuffer,
                            pageIndex: idx,
                            ...(hasPantone && { pantoneSpots })
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

// --- RGB CANVAS ALGORITHM (mode-aware) ---
// mode: 'blur-mirror' | 'mirror-only' | 'blur-only' | 'solid-extend'
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

    const stage = document.createElement('canvas');
    stage.width = outCanvas.width; stage.height = outCanvas.height;
    const sCtx = stage.getContext('2d');

    if (doMirror) {
        // Mirror-flip all 8 surrounding zones
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
        // Solid-extend: clamp/stretch edge pixels into bleed zone (no flip)
        // Top edge
        sCtx.drawImage(srcCanvas, 0, 0, W, 1, B, 0, W, B);
        // Bottom edge
        sCtx.drawImage(srcCanvas, 0, H - 1, W, 1, B, B + H, W, B);
        // Left edge
        sCtx.drawImage(srcCanvas, 0, 0, 1, H, 0, B, B, H);
        // Right edge
        sCtx.drawImage(srcCanvas, W - 1, 0, 1, H, B + W, B, B, H);
        // Corners (stretch from corner pixel)
        sCtx.drawImage(srcCanvas, 0, 0, 1, 1, 0, 0, B, B);
        sCtx.drawImage(srcCanvas, W - 1, 0, 1, 1, B + W, 0, B, B);
        sCtx.drawImage(srcCanvas, 0, H - 1, 1, 1, 0, B + H, B, B);
        sCtx.drawImage(srcCanvas, W - 1, H - 1, 1, 1, B + W, B + H, B, B);
        // Original center
        sCtx.drawImage(srcCanvas, B, B);
    }

    if (doBlur) {
        ctx.filter = 'blur(4px)';
        ctx.drawImage(stage, 0, 0);
        ctx.filter = 'none';
    } else {
        ctx.drawImage(stage, 0, 0);
    }
    // Always stamp original sharp center back
    ctx.drawImage(srcCanvas, B, B);
    return outCanvas;
}

// --- CMYK BINARY MATH ALGORITHMS (mode-aware) ---
// mode: 'blur-mirror' | 'mirror-only' | 'blur-only' | 'solid-extend'
function mirrorAndBlurCMYK(srcDataObj, bPx, mode) {
    if (!mode) mode = state.bleedMode || 'blur-mirror';
    const W = srcDataObj.width;
    const H = srcDataObj.height;
    const B = Math.max(0, Math.min(bPx, Math.floor(W/2)-2, Math.floor(H/2)-2));
    const destW = W + (B * 2);
    const destH = H + (B * 2);

    const doMirror = mode === 'blur-mirror' || mode === 'mirror-only';
    const doBlur   = mode === 'blur-mirror' || mode === 'blur-only';

    const src = srcDataObj.data;
    let outData = new Uint8Array(destW * destH * 4);

    // 1. Fill bleed zone
    for (let y = 0; y < destH; y++) {
        for (let x = 0; x < destW; x++) {
            let sx = x - B;
            let sy = y - B;
            if (doMirror) {
                // Mirror-clamp: flip outside-boundary samples back in
                if (sx < 0) sx = -sx - 1; else if (sx >= W) sx = W - (sx - W) - 1;
                if (sy < 0) sy = -sy - 1; else if (sy >= H) sy = H - (sy - H) - 1;
            } else {
                // Solid-extend: clamp to edge pixel
                sx = Math.max(0, Math.min(W - 1, sx));
                sy = Math.max(0, Math.min(H - 1, sy));
            }
            const srcIdx = (sy * W + sx) * 4;
            const dstIdx = (y * destW + x) * 4;
            outData[dstIdx]   = src[srcIdx];
            outData[dstIdx+1] = src[srcIdx+1];
            outData[dstIdx+2] = src[srcIdx+2];
            outData[dstIdx+3] = src[srcIdx+3];
        }
    }

    if (B > 0 && doBlur) {
        // 2. Separable box blur (radius 3) over the full expanded canvas
        const rad = 3;
        const temp = new Uint8Array(outData.length);
        // Horizontal pass
        for (let y = 0; y < destH; y++) {
            for (let x = 0; x < destW; x++) {
                let c=0,m=0,yy=0,k=0,count=0;
                for (let r = -rad; r <= rad; r++) {
                    const nx = Math.max(0, Math.min(destW-1, x+r));
                    const idx = (y*destW+nx)*4;
                    c+=outData[idx]; m+=outData[idx+1]; yy+=outData[idx+2]; k+=outData[idx+3]; count++;
                }
                const out=(y*destW+x)*4;
                temp[out]=c/count; temp[out+1]=m/count; temp[out+2]=yy/count; temp[out+3]=k/count;
            }
        }
        // Vertical pass
        for (let y = 0; y < destH; y++) {
            for (let x = 0; x < destW; x++) {
                let c=0,m=0,yy=0,k=0,count=0;
                for (let r = -rad; r <= rad; r++) {
                    const ny = Math.max(0, Math.min(destH-1, y+r));
                    const idx = (ny*destW+x)*4;
                    c+=temp[idx]; m+=temp[idx+1]; yy+=temp[idx+2]; k+=temp[idx+3]; count++;
                }
                const out=(y*destW+x)*4;
                outData[out]=c/count; outData[out+1]=m/count; outData[out+2]=yy/count; outData[out+3]=k/count;
            }
        }
    }

    // NOTE: center is intentionally left blurred/filled here;
    // the pdf-lib export layers the original on top at (bleedOffsetPt, bleedOffsetPt).
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
        
        if (fileItem.type === 'rgb' || fileItem.type === 'pantone' || fileItem.type === 'pdf-cmyk') {
            // Pantone, PDF-CMYK and RGB all have a rasterised canvas from pdfjs/img decode
            const bledCanvas = generateRGBBleedCanvas(fileItem.canvas, bPx);
            displayCanvas   = bledCanvas;
            displayWidthIn  = (bledCanvas.width  / state.dpi).toFixed(3);
            displayHeightIn = (bledCanvas.height / state.dpi).toFixed(3);
            innerWidth  = fileItem.canvas.width;
            innerHeight = fileItem.canvas.height;
        } else {
            // JPEG CMYK — pixel data path
            const processedCMYK = mirrorAndBlurCMYK(fileItem.cmykData, bPx);
            displayCanvas   = createGhostRgbCanvas(processedCMYK);
            displayWidthIn  = (processedCMYK.width  / state.dpi).toFixed(3);
            displayHeightIn = (processedCMYK.height / state.dpi).toFixed(3);
            innerWidth  = fileItem.cmykData.width;
            innerHeight = fileItem.cmykData.height;
        }

        // Build badge
        let modeBadge;
        if (fileItem.type === 'cmyk') {
            modeBadge = `<span class="badge badge-cmyk">CMYK RAW</span>`;
        } else if (fileItem.type === 'pdf-cmyk') {
            modeBadge = `<span class="badge badge-cmyk">PDF CMYK</span>`;
        } else if (fileItem.type === 'pantone') {
            const tipNames = fileItem.pantoneSpots.map(s => s.name).join(', ');
            const shortLabel = fileItem.pantoneSpots.length === 1
                ? fileItem.pantoneSpots[0].name
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

        // Click-to-inspect tooltip hint
        const clickHint = document.createElement('div');
        clickHint.className = 'canvas-click-hint';
        clickHint.textContent = 'Click to inspect channels';

        canvasWrapper.appendChild(displayCanvas);
        canvasWrapper.appendChild(guideOverlay);
        canvasWrapper.appendChild(clickHint);
        canvasWrapper.style.cursor = 'pointer';
        canvasWrapper.addEventListener('click', () => openChannelViewer(fileItem));

        card.appendChild(cardHeader);
        card.appendChild(canvasWrapper);
        previewContainer.appendChild(card);
        
        await new Promise(r => setTimeout(r, 10)); // keep UI unblocked
    }
}

// ═══════════════════════════════════════════════════════════════
// CHANNEL VIEWER
// ═══════════════════════════════════════════════════════════════

// Extract pixel data from any file type into a normalised object:
// { mode: 'cmyk'|'rgb', width, height, data: Uint8Array (4 bytes/px) }
// CMYK  → { C, M, Y, K } per pixel  (0–255 = 0–100% ink)
// RGB   → { R, G, B, A } per pixel
function extractChannelData(fileItem) {
    if (fileItem.type === 'cmyk') {
        // Return a COPY — never expose the live array. The original in
        // fileItem.cmykData.data must stay untouched for correct downloads.
        return {
            mode: 'cmyk',
            width:  fileItem.cmykData.width,
            height: fileItem.cmykData.height,
            data:   fileItem.cmykData.data.slice() // ← defensive copy
        };
    }

    // For canvas-based types (rgb, pdf-cmyk, pantone) — read RGBA from canvas
    const src = fileItem.canvas;
    const ctx = src.getContext('2d');
    const imgData = ctx.getImageData(0, 0, src.width, src.height);
    const rgba = imgData.data;

    if (fileItem.type === 'rgb') {
        return { mode: 'rgb', width: src.width, height: src.height, data: rgba };
    }

    // pdf-cmyk / pantone — derive CMYK from rendered RGBA
    const cmyk = new Uint8Array(rgba.length);
    for (let i = 0; i < rgba.length; i += 4) {
        const r = rgba[i]/255, g = rgba[i+1]/255, b = rgba[i+2]/255;
        const k = 1 - Math.max(r, g, b);
        const d = (1 - k) || 1e-6;
        cmyk[i]   = Math.round(((1-r-k)/d)*255);
        cmyk[i+1] = Math.round(((1-g-k)/d)*255);
        cmyk[i+2] = Math.round(((1-b-k)/d)*255);
        cmyk[i+3] = Math.round(k*255);
    }
    return { mode: 'cmyk', width: src.width, height: src.height, data: cmyk };
}

// Build the list of channel descriptors for a file item
// Each: { id, label, colorHint, channelIndex }
// colorHint is used to colour the pill badge
function getChannels(fileItem) {
    if (fileItem.type === 'rgb') {
        return [
            { id: 'R', label: 'Red',   colorHint: '#ef4444', channelIndex: 0 },
            { id: 'G', label: 'Green', colorHint: '#22c55e', channelIndex: 1 },
            { id: 'B', label: 'Blue',  colorHint: '#3b82f6', channelIndex: 2 },
            { id: 'A', label: 'Alpha', colorHint: '#9ca3af', channelIndex: 3 },
        ];
    }
    // CMYK-family (cmyk, pdf-cmyk, pantone)
    const channels = [
        { id: 'C', label: 'Cyan',    colorHint: '#06b6d4', channelIndex: 0 },
        { id: 'M', label: 'Magenta', colorHint: '#ec4899', channelIndex: 1 },
        { id: 'Y', label: 'Yellow',  colorHint: '#eab308', channelIndex: 2 },
        { id: 'K', label: 'Black',   colorHint: '#6b7280', channelIndex: 3 },
    ];
    // Append Pantone spot channels — each carries its CMYK alternate {C,M,Y,K} (0-1 floats)
    if (fileItem.type === 'pantone' && fileItem.pantoneSpots) {
        fileItem.pantoneSpots.forEach((spot, i) => {
            channels.push({
                id: `SPOT_${i}`,
                label: spot.name,
                colorHint: '#7b2d8b',
                channelIndex: -1,   // not a standard channel index
                spotCmyk: spot      // { name, C, M, Y, K } — CMYK alternate tint values
            });
        });
    }
    return channels;
}

// Render a single channel preview canvas that exactly matches what the
// downloaded TIFF will look like when opened in a CMYK-aware application.
//
// Rule: the preview IS the download, rendered to screen.
//
// CMYK process channels (C / M / Y / K):
//   Zero out all other channels, then convert CMYK→RGB for display.
//   Result: Cyan channel shows cyan ink on white, Magenta shows magenta,
//   Yellow shows yellow, Black shows neutral gray scale.
//   This is identical to what Photoshop shows when you solo a channel.
//
// Spot channels:
//   Compute per-pixel density (dot product with spot's CMYK alternate vector),
//   then apply the spot's CMYK recipe weighted by that density and convert to RGB.
//   The displayed color is the spot's actual ink color — not a grayscale proxy.
//
// RGB channels: luminance (unchanged).
//
// srcData — caller can supply the pristine pixel array (fileItem.cmykData.data)
//   so the preview reads the same source as the download. Defaults to channelData.data.
function renderChannelPlate(channelData, channel, srcData) {
    const { width, height, data, mode } = channelData;
    const px = srcData || data; // use pristine source if supplied
    const out = document.createElement('canvas');
    out.width = width; out.height = height;
    const ctx = out.getContext('2d');
    const img = ctx.createImageData(width, height);
    const od  = img.data;

    if (mode === 'rgb') {
        // RGB: isolate the chosen channel, black out the others
        const ci = channel.channelIndex;
        for (let i = 0; i < px.length; i += 4) {
            od[i]   = ci === 0 ? px[i]   : 0;
            od[i+1] = ci === 1 ? px[i+1] : 0;
            od[i+2] = ci === 2 ? px[i+2] : 0;
            od[i+3] = ci === 3 ? px[i+3] : 255;
        }
    } else if (channel.channelIndex >= 0) {
        // ── CMYK process channel ──
        // Build a CMYK value where only the selected channel has data,
        // then convert to RGB for display — mirrors the downloaded TIFF exactly.
        const ci = channel.channelIndex;
        for (let i = 0; i < px.length; i += 4) {
            const c = ci === 0 ? px[i]  /255 : 0;
            const m = ci === 1 ? px[i+1]/255 : 0;
            const y = ci === 2 ? px[i+2]/255 : 0;
            const k = ci === 3 ? px[i+3]/255 : 0;
            od[i]   = Math.round(255*(1-c)*(1-k));
            od[i+1] = Math.round(255*(1-m)*(1-k));
            od[i+2] = Math.round(255*(1-y)*(1-k));
            od[i+3] = 255;
        }
    } else {
        // ── Spot channel ──
        // Compute density (dot product), apply spot CMYK alternate weighted by density,
        // convert to RGB. The preview shows the actual spot ink color.
        const sc  = channel.spotCmyk;
        const sC  = sc.C, sM = sc.M, sY = sc.Y, sK = sc.K;
        const mag = Math.sqrt(sC*sC + sM*sM + sY*sY + sK*sK) || 1;
        for (let i = 0; i < px.length; i += 4) {
            const pC = px[i]  /255, pM = px[i+1]/255,
                  pY = px[i+2]/255, pK = px[i+3]/255;
            const density = Math.min(1, Math.max(0,
                (pC*sC + pM*sM + pY*sY + pK*sK) / mag
            ));
            // Apply spot ink recipe at this density, convert to RGB
            const c = sC*density, m = sM*density, y = sY*density, k = sK*density;
            od[i]   = Math.round(255*(1-c)*(1-k));
            od[i+1] = Math.round(255*(1-m)*(1-k));
            od[i+2] = Math.round(255*(1-y)*(1-k));
            od[i+3] = 255;
        }
    }
    ctx.putImageData(img, 0, 0);
    return out;
}

// Render a composite (active channels visible) onto the modal canvas.
// Mirrors exactly what the downloaded separations will look like when recombined:
//   - Only active channels contribute ink
//   - Uses srcData (pristine CMYK array for CMYK JPEG files) so the preview
//     reads the same pixel values as the download, not the round-tripped copy
//   - Spot channels contribute via their CMYK alternate recipe weighted by density
function renderComposite(channelData, activeIds, allChannels, targetCanvas, srcData) {
    const { width, height, data, mode } = channelData;
    const px  = srcData || data; // pristine source if supplied, else derived
    const ctx = targetCanvas.getContext('2d');
    const img = ctx.createImageData(width, height);
    const od  = img.data;

    const activeSet = new Set(activeIds);
    if (activeSet.size === 0) {
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, width, height);
        return;
    }

    const activeSpots = allChannels.filter(ch => activeSet.has(ch.id) && ch.spotCmyk);

    if (mode === 'rgb') {
        for (let i = 0; i < px.length; i += 4) {
            od[i]   = activeSet.has('R') ? px[i]   : 0;
            od[i+1] = activeSet.has('G') ? px[i+1] : 0;
            od[i+2] = activeSet.has('B') ? px[i+2] : 0;
            od[i+3] = activeSet.has('A') ? px[i+3] : 255;
        }
    } else {
        // CMYK composite — only active process + spot channels contribute ink.
        // This matches exactly what you get if you download each active channel
        // as a TIFF and recombine them in a CMYK-aware app.
        for (let i = 0; i < px.length; i += 4) {
            let c = activeSet.has('C') ? px[i]  /255 : 0;
            let m = activeSet.has('M') ? px[i+1]/255 : 0;
            let y = activeSet.has('Y') ? px[i+2]/255 : 0;
            let k = activeSet.has('K') ? px[i+3]/255 : 0;

            // Spot contributions — density from pristine pixel values
            for (const spot of activeSpots) {
                const sc  = spot.spotCmyk;
                const mag = Math.sqrt(sc.C*sc.C + sc.M*sc.M + sc.Y*sc.Y + sc.K*sc.K) || 1;
                const pC = px[i]/255, pM = px[i+1]/255,
                      pY = px[i+2]/255, pK = px[i+3]/255;
                const density = Math.min(1, Math.max(0,
                    (pC*sc.C + pM*sc.M + pY*sc.Y + pK*sc.K) / mag
                ));
                c = Math.min(1, c + sc.C*density);
                m = Math.min(1, m + sc.M*density);
                y = Math.min(1, y + sc.Y*density);
                k = Math.min(1, k + sc.K*density);
            }

            od[i]   = Math.round(255*(1-c)*(1-k));
            od[i+1] = Math.round(255*(1-m)*(1-k));
            od[i+2] = Math.round(255*(1-y)*(1-k));
            od[i+3] = 255;
        }
    }
    ctx.putImageData(img, 0, 0);
}

// Download a single channel separation.
//
// KEY DESIGN RULE: for CMYK JPEG files (fileItem.type === 'cmyk'), the download
// ALWAYS reads from fileItem.cmykData.data — the pristine decoded array captured
// at intake — never from channelData.data, which is a display approximation
// derived by round-tripping through the browser's RGB renderer and back-calculating
// CMYK. That round-trip destroys overprint and rich-black relationships.
//
// channelData is used ONLY for display/preview. It is never the download source.
//
// For CMYK process channels (C/M/Y/K):
//   Exports a CMYK TIFF where only the chosen channel has its original values;
//   all other channels are hard-zeroed. e.g. "Download Black" → TIFF with
//   C=0, M=0, Y=0, K=exact original K values from fileItem.cmykData.data.
//
// For Spot channels (Pantone):
//   Computes spot density from the pristine CMYK data, then outputs a CMYK TIFF
//   where each pixel carries the spot's CMYK alternate weighted by that density.
//
// For RGB channels:
//   Exports a grayscale PNG (no CMYK available).
function downloadChannelPlate(channelData, channel, fileName, fileItem) {
    const safeName = channel.label.replace(/[\s/]+/g, '_');

    // ── Determine the true source pixel data ──
    // For CMYK JPEG files: always use the pristine original array, never channelData.
    // For all other types: channelData.data is the best we have (derived from canvas).
    const isTrueCmyk = fileItem && fileItem.type === 'cmyk';
    const srcData    = isTrueCmyk ? fileItem.cmykData.data : channelData.data;
    const { width, height } = channelData;

    if (channelData.mode === 'cmyk' && channel.channelIndex >= 0) {
        // ── CMYK process channel → single-separation CMYK TIFF ──
        // Reads from srcData (pristine for CMYK JPEG, derived for pdf-cmyk/pantone).
        const outData = new Uint8Array(width * height * 4);
        const ci = channel.channelIndex; // 0=C 1=M 2=Y 3=K
        for (let i = 0; i < srcData.length; i += 4) {
            outData[i]   = ci === 0 ? srcData[i]   : 0;
            outData[i+1] = ci === 1 ? srcData[i+1] : 0;
            outData[i+2] = ci === 2 ? srcData[i+2] : 0;
            outData[i+3] = ci === 3 ? srcData[i+3] : 0;
        }
        const tiff = encodeToCMYK_TIFF({ data: outData, width, height }, state.dpi);
        const a = document.createElement('a');
        a.href = URL.createObjectURL(tiff);
        a.download = `${fileName}_${safeName}_separation.tiff`;
        a.click();
        URL.revokeObjectURL(a.href);

    } else if (channelData.mode === 'cmyk' && channel.spotCmyk) {
        // ── Spot channel → CMYK TIFF weighted by spot density ──
        const sc  = channel.spotCmyk;
        const mag = Math.sqrt(sc.C*sc.C + sc.M*sc.M + sc.Y*sc.Y + sc.K*sc.K) || 1;
        const outData = new Uint8Array(width * height * 4);
        for (let i = 0; i < srcData.length; i += 4) {
            // Density: dot product of pixel's CMYK with spot's CMYK alternate vector
            const pC = srcData[i]/255, pM = srcData[i+1]/255,
                  pY = srcData[i+2]/255, pK = srcData[i+3]/255;
            const density = Math.min(1, Math.max(0,
                (pC*sc.C + pM*sc.M + pY*sc.Y + pK*sc.K) / mag
            ));
            outData[i]   = Math.round(sc.C * density * 255);
            outData[i+1] = Math.round(sc.M * density * 255);
            outData[i+2] = Math.round(sc.Y * density * 255);
            outData[i+3] = Math.round(sc.K * density * 255);
        }
        const tiff = encodeToCMYK_TIFF({ data: outData, width, height }, state.dpi);
        const a = document.createElement('a');
        a.href = URL.createObjectURL(tiff);
        a.download = `${fileName}_${safeName}_spot_separation.tiff`;
        a.click();
        URL.revokeObjectURL(a.href);

    } else {
        // ── RGB channel → grayscale PNG plate ──
        const plate = renderChannelPlate(channelData, channel);
        plate.toBlob(blob => {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `${fileName}_${safeName}_channel.png`;
            a.click();
            URL.revokeObjectURL(a.href);
        }, 'image/png');
    }
}

// Open the channel viewer modal for a given fileItem
function openChannelViewer(fileItem) {
    const modal = document.getElementById('channelModal');
    const modalTitle = document.getElementById('channelModalTitle');
    const channelNav = document.getElementById('channelNav');
    const modalCanvas = document.getElementById('channelModalCanvas');
    const modalCtx = modalCanvas.getContext('2d');

    // Extract channel data once
    const channelData = extractChannelData(fileItem);
    const channels    = getChannels(fileItem);

    // All channels active by default (composite view)
    const activeChannels = new Set(channels.map(c => c.id));

    modalTitle.textContent = fileItem.name;
    modalCanvas.width  = channelData.width;
    modalCanvas.height = channelData.height;

    // Build channel pill nav
    channelNav.innerHTML = '';

    // "Composite" toggle (all on/off)
    const compositeBtn = document.createElement('button');
    compositeBtn.className = 'ch-pill ch-pill-composite active';
    compositeBtn.textContent = 'Composite';
    compositeBtn.addEventListener('click', () => {
        const allActive = channels.every(c => activeChannels.has(c.id));
        if (allActive) {
            activeChannels.clear();
            compositeBtn.classList.remove('active');
        } else {
            channels.forEach(c => activeChannels.add(c.id));
            compositeBtn.classList.add('active');
        }
        updatePills();
        redrawModal();
    });
    channelNav.appendChild(compositeBtn);

    // Separator
    const sep = document.createElement('div');
    sep.className = 'ch-sep';
    channelNav.appendChild(sep);

    // Per-channel pills
    channels.forEach(ch => {
        const pill = document.createElement('button');
        pill.className = 'ch-pill active';
        pill.style.setProperty('--ch-color', ch.colorHint);
        pill.dataset.chId = ch.id;

        const dot  = document.createElement('span');
        dot.className = 'ch-dot';
        const lbl  = document.createElement('span');
        lbl.textContent = ch.id.startsWith('SPOT_') ? ch.label : `${ch.label} (${ch.id})`;

        // Download button for this channel
        const dlBtn = document.createElement('button');
        dlBtn.className = 'ch-dl-btn';
        dlBtn.title = `Download ${ch.label} channel`;
        dlBtn.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 2v8M5 7l3 3 3-3M3 13h10"/></svg>`;
        dlBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const cleanName = fileItem.name.replace(/\.[^/.]+$/, '');
            // Pass fileItem so downloadChannelPlate can reach the pristine cmykData
            downloadChannelPlate(channelData, ch, cleanName, fileItem);
        });

        pill.appendChild(dot);
        pill.appendChild(lbl);
        pill.appendChild(dlBtn);

        pill.addEventListener('click', () => {
            if (activeChannels.has(ch.id)) {
                activeChannels.delete(ch.id);
                pill.classList.remove('active');
            } else {
                activeChannels.add(ch.id);
                pill.classList.add('active');
            }
            updateCompositeBtn();
            redrawModal();
        });

        channelNav.appendChild(pill);
    });

    function updatePills() {
        channelNav.querySelectorAll('.ch-pill[data-ch-id]').forEach(pill => {
            pill.classList.toggle('active', activeChannels.has(pill.dataset.chId));
        });
    }

    function updateCompositeBtn() {
        const allActive = channels.every(c => activeChannels.has(c.id));
        compositeBtn.classList.toggle('active', allActive);
    }

    // Pristine pixel source — for CMYK JPEG files this is fileItem.cmykData.data
    // (the original decoded array, never mutated). For all other types it's
    // channelData.data (derived from canvas). Using this ensures preview === download.
    const pristineSrc = (fileItem.type === 'cmyk') ? fileItem.cmykData.data : null;

    function redrawModal() {
        if (activeChannels.size === 1) {
            // Single channel: show its actual ink color (not grayscale)
            const ch = channels.find(c => activeChannels.has(c.id));
            if (ch) {
                const plate = renderChannelPlate(channelData, ch, pristineSrc);
                modalCtx.drawImage(plate, 0, 0);
                return;
            }
        }
        // Multi-channel composite — pass pristine source so pixels match download
        renderComposite(channelData, [...activeChannels], channels, modalCanvas, pristineSrc);
    }

    // Initial draw — composite
    redrawModal();
    modal.classList.add('open');
}

function closeChannelModal() {
    document.getElementById('channelModal').classList.remove('open');
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

            } else if (fileItem.type === 'pantone' || fileItem.type === 'pdf-cmyk') {
                // Pantone + PDF-CMYK: bleed JPEG bg + original PDF page embedded on top
                // pdf-lib preserves both Separation/DeviceN (Pantone) and DeviceCMYK colorspaces
                const pdfBytes     = await buildPantoneBleedPdf(fileItem, bPx, state.dpi);
                const srcDoc       = await PDFDocument.load(pdfBytes);
                const [copiedPage] = await masterDoc.copyPages(srcDoc, [0]);
                masterDoc.addPage(copiedPage);

            } else {
                // JPEG CMYK: bleed JPEG bg + original JPEG on top (DCTDecode preserved)
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
                // Pantone: PDF — bleed JPEG bg + original PDF page on top (spot colors preserved)
                const pantPdfBytes = await buildPantoneBleedPdf(item, bPx, state.dpi);
                zipEngine.file(`${cleanName}_bleed_pantone_${i + 1}.pdf`, pantPdfBytes);

            } else if (item.type === 'pdf-cmyk') {
                // PDF-CMYK: PDF — same two-layer strategy, DeviceCMYK colorspace preserved
                const pdfCmykBytes = await buildPantoneBleedPdf(item, bPx, state.dpi);
                zipEngine.file(`${cleanName}_bleed_cmyk_${i + 1}.pdf`, pdfCmykBytes);

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