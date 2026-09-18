import { LOGO_JPEG_BASE64, LOGO_JPEG_WIDTH, LOGO_JPEG_HEIGHT } from "./logo-data";

type PdfOptions = {
  title: string;
  subtitle?: string;
  lines: string[];
  barcode?: string | null;
};

const eanL = ["0001101", "0011001", "0010011", "0111101", "0100011", "0110001", "0101111", "0111011", "0110111", "0001011"];
const eanG = ["0100111", "0110011", "0011011", "0100001", "0011101", "0111001", "0000101", "0010001", "0001001", "0010111"];
const eanR = ["1110010", "1100110", "1101100", "1000010", "1011100", "1001110", "1010000", "1000100", "1001000", "1110100"];
const eanParity = ["LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG", "LGGLLG", "LGGGLL", "LGLGLG", "LGLGGL", "LGGLGL"];

// Larghezze Helvetica (unità/1000) per allineare a destra i prezzi.
const helvWidths: Record<string, number> = { " ": 278, "!": 278, "\"": 355, "#": 556, "$": 556, "%": 889, "&": 667, "'": 191, "(": 333, ")": 333, "*": 389, "+": 584, ",": 278, "-": 333, ".": 278, "/": 278, "0": 556, "1": 556, "2": 556, "3": 556, "4": 556, "5": 556, "6": 556, "7": 556, "8": 556, "9": 556, ":": 278, ";": 278, "<": 584, "=": 584, ">": 584, "?": 556, "@": 1015, A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 500, K: 667, L: 556, M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611, U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611, "[": 278, "\\": 278, "]": 278, "^": 469, _: 556, "`": 333, a: 556, b: 556, c: 500, d: 556, e: 556, f: 278, g: 556, h: 556, i: 222, j: 222, k: 500, l: 222, m: 833, n: 556, o: 556, p: 556, q: 556, r: 333, s: 500, t: 278, u: 556, v: 500, w: 722, x: 500, y: 500, z: 500, "{": 334, "|": 260, "}": 334, "~": 584 };

function textWidth(value: string, size: number) {
  let units = 0;
  for (const char of value) units += helvWidths[char] ?? 556;
  return units / 1000 * size;
}

function ascii(value: string) {
  return value.replaceAll("·", "-").replaceAll("€", "EUR").replace(/[’‘]/g, "'").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\x20-\x7E]/g, "?");
}

function escapePdf(value: string) {
  return ascii(value).replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

function barcodeBits(code: string) {
  if (!/^\d{13}$/.test(code)) return null;
  const first = Number(code[0]);
  const parity = eanParity[first];
  let bits = "101";
  for (let index = 1; index <= 6; index += 1) {
    const digit = Number(code[index]);
    bits += parity[index - 1] === "L" ? eanL[digit] : eanG[digit];
  }
  bits += "01010";
  for (let index = 7; index <= 12; index += 1) bits += eanR[Number(code[index])];
  return `${bits}101`;
}

function textCommand(value: string, x: number, y: number, size: number, bold = false, gray = "0") {
  return `${gray} g BT /${bold ? "F2" : "F1"} ${size} Tf ${x} ${y} Td (${escapePdf(value)}) Tj ET`;
}

// Testo allineato a destra: il bordo destro finisce in `right`.
function textRight(value: string, right: number, y: number, size: number, bold = false, gray = "0") {
  const x = right - textWidth(ascii(value), size);
  return textCommand(value, x, y, size, bold, gray);
}

export function createPdf(options: PdfOptions) {
  const commands: string[] = [
    "q 0 g 0 724 595 118 re f Q",
    // Logo aziendale (immagine) nell'intestazione scura.
    "q 60 0 0 60 34 752 cm /Im0 Do Q",
    textCommand("MARINELLI STEFANO", 108, 788, 19, true, "1"),
    textCommand("P.IVA 02504600566", 108, 769, 10, false, "1"),
    textCommand("STRADA CASSIA NORD KM 85+800", 108, 753, 10, false, "1"),
    "q 1 g 0 G 1.2 w 35 667 525 42 re B Q",
    textCommand(options.title, 48, 682, 20, true, "0"),
  ];
  if (options.subtitle) commands.push(textRight(options.subtitle, 547, 684, 9, false, "0.28"));

  const visibleLines = options.lines.slice(0, 42);
  const lowerBoundary = options.barcode ? 186 : 58;
  const lineHeight = Math.max(11, Math.min(17, (646 - lowerBoundary) / Math.max(visibleLines.length, 1)));
  let y = 646;
  visibleLines.forEach((line, index) => {
    if (line.startsWith("---")) {
      commands.push(`0.55 G 48 ${y + 4} m 547 ${y + 4} l S`);
      y -= Math.max(8, lineHeight * .65);
      return;
    }
    const totalLine = /^(TOTALE|SALDO|IMPORTO DA PAGARE)/i.test(line);
    if (totalLine) {
      commands.push(`q 0 g 42 ${y - 5} 511 ${lineHeight + 5} re f Q`);
      const size = Math.min(11, lineHeight - 2);
      const [left, right] = line.split("\t");
      commands.push(textCommand((left ?? line).slice(0, 92), 51, y, size, true, "1"));
      if (right !== undefined) commands.push(textRight(right, 545, y, size, true, "1"));
    } else {
      if (index % 2 === 1) commands.push(`q 0.94 g 42 ${y - 5} 511 ${lineHeight + 4} re f Q`);
      const size = Math.min(10, lineHeight - 1);
      const [left, right] = line.split("\t");
      const emphasized = /^(Numero|Codice|Cliente|Data|Negozio|Valore|Acconto|Totale concordato|Prodotti prenotati|Prodotti da risuolare|Descrizione|Mittente|Ricevente|Vettore|Causale)/i.test(left ?? line);
      // Prezzo allineato a destra quando la riga contiene un separatore \t.
      if (right !== undefined) {
        commands.push(textCommand(left.slice(0, 62), 51, y, size, emphasized));
        commands.push(textRight(right, 545, y, size, false));
      } else {
        commands.push(textCommand(line.slice(0, 92), 51, y, size, emphasized));
      }
    }
    y -= lineHeight;
  });
  if (options.lines.length > visibleLines.length) commands.push(textCommand(`Altre ${options.lines.length - visibleLines.length} voci non visualizzate`, 51, y, 9, true, "0"));

  const bits = options.barcode ? barcodeBits(options.barcode) : null;
  if (bits && options.barcode) {
    const moduleWidth = 1.9;
    const startX = (595 - bits.length * moduleWidth) / 2;
    const panelBottom = Math.max(46, y - 150);
    const startY = panelBottom + 25;
    commands.push(
      `q 1 g 0 G 1.5 w 145 ${panelBottom} 305 122 re B Q`,
      textCommand("EAN PER RICHIAMO RAPIDO IN CASSA", 196, panelBottom + 102, 8, true, "0"),
      "0 g",
    );
    for (let index = 0; index < bits.length; index += 1) {
      if (bits[index] !== "1") continue;
      const guard = index < 3 || (index >= 45 && index < 50) || index >= 92;
      commands.push(`${startX + index * moduleWidth} ${startY} ${moduleWidth} ${guard ? 58 : 50} re f`);
    }
    commands.push(textCommand(options.barcode, 249, panelBottom + 9, 10, true, "0"));
  }

  commands.push(
    "0.55 G 35 35 m 560 35 l S",
    textCommand("Marinelli Stefano · Documento generato dal gestionale", 42, 20, 8, false, "0.35"),
    textCommand("Pagina 1", 510, 20, 8, false, "0.35"),
  );

  const stream = `${commands.join("\n")}\n`;
  const encoder = new TextEncoder();
  const streamBytes = encoder.encode(stream);
  const logoBytes = Uint8Array.from(atob(LOGO_JPEG_BASE64), (char) => char.charCodeAt(0));

  // Serializzazione con oggetti misti testo + immagine binaria (JPEG /DCTDecode).
  const parts: Uint8Array[] = [];
  let length = 0;
  const offsets: number[] = [0];
  const pushText = (text: string) => { const bytes = encoder.encode(text); parts.push(bytes); length += bytes.length; };
  const pushBytes = (bytes: Uint8Array) => { parts.push(bytes); length += bytes.length; };
  const startObject = () => { offsets.push(length); };

  pushText("%PDF-1.4\n%PDFBIN\n"); // header

  startObject();
  pushText("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  startObject();
  pushText("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");
  startObject();
  pushText("3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> /XObject << /Im0 7 0 R >> >> /Contents 6 0 R >>\nendobj\n");
  startObject();
  pushText("4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n");
  startObject();
  pushText("5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>\nendobj\n");
  startObject();
  pushText(`6 0 obj\n<< /Length ${streamBytes.length} >>\nstream\n`);
  pushBytes(streamBytes);
  pushText("endstream\nendobj\n");
  startObject();
  pushText(`7 0 obj\n<< /Type /XObject /Subtype /Image /Width ${LOGO_JPEG_WIDTH} /Height ${LOGO_JPEG_HEIGHT} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${logoBytes.length} >>\nstream\n`);
  pushBytes(logoBytes);
  pushText("\nendstream\nendobj\n");

  const xref = length;
  const objectCount = 7;
  let tail = `xref\n0 ${objectCount + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index <= objectCount; index += 1) tail += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  tail += `trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  pushText(tail);

  const output = new Uint8Array(length);
  let position = 0;
  for (const part of parts) { output.set(part, position); position += part.length; }
  return output;
}

export function euro(value: number) {
  return `${value.toFixed(2)} EUR`;
}
