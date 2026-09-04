const baseUrl = (process.argv[2] ?? "http://librarian:5001").replace(/\/$/, "");
const phrase = "OpenNeko digital librarian smoke test";

function minimalPdf(text) {
  const escaped = text.replace(/[()\\]/g, "\\$&");
  const stream = `BT /F1 16 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const parts = [Buffer.from("%PDF-1.4\n")];
  const offsets = [0];
  let length = parts[0].length;
  for (let index = 0; index < objects.length; index++) {
    offsets.push(length);
    const object = Buffer.from(`${index + 1} 0 obj\n${objects[index]}\nendobj\n`);
    parts.push(object);
    length += object.length;
  }
  const xref = length;
  const rows = offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  parts.push(
    Buffer.from(
      `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${rows}` +
        `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
        `startxref\n${xref}\n%%EOF\n`,
    ),
  );
  return Buffer.concat(parts);
}

const form = new FormData();
form.append("files", new Blob([minimalPdf(phrase)], { type: "application/pdf" }), "smoke.pdf");
form.append("from_formats", "pdf");
form.append("do_ocr", "false");
const submitted = await fetch(`${baseUrl}/v1/convert/file/async`, {
  method: "POST",
  body: form,
});
if (submitted.status !== 202) {
  throw new Error(`submit failed: HTTP ${submitted.status} ${await submitted.text()}`);
}
const { task_id: taskId } = await submitted.json();
if (!taskId) throw new Error("submit returned no task id");

let taskStatus = "pending";
for (let attempt = 0; attempt < 120; attempt++) {
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const polled = await fetch(`${baseUrl}/v1/status/poll/${taskId}`);
  if (!polled.ok) throw new Error(`poll failed: HTTP ${polled.status}`);
  const payload = await polled.json();
  taskStatus = payload.task_status;
  if (taskStatus === "success" || taskStatus === "failure") break;
}
if (taskStatus !== "success") {
  throw new Error(`conversion ended as ${taskStatus}`);
}
const response = await fetch(`${baseUrl}/v1/result/${taskId}`);
if (!response.ok) throw new Error(`result failed: HTTP ${response.status}`);
const result = await response.json();
const markdown = result.document?.md_content ?? "";
if (result.status !== "success" || !markdown.includes(phrase)) {
  throw new Error(`unexpected result: ${JSON.stringify(result).slice(0, 1_000)}`);
}
console.log(`librarian_pdf_async=ok chars=${markdown.length}`);
