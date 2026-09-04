export const LIBRARY_SUPPORTED_EXTENSIONS = [
  ".pdf",
  ".docx",
  ".pptx",
  ".xlsx",
  ".csv",
  ".md",
  ".markdown",
  ".txt",
] as const;

export type LibrarySupportedExtension = (typeof LIBRARY_SUPPORTED_EXTENSIONS)[number];

const SUPPORTED = new Set<string>(LIBRARY_SUPPORTED_EXTENSIONS);
const DIRECT_TEXT = new Set<LibrarySupportedExtension>([
  ".md",
  ".markdown",
  ".txt",
]);

export const LIBRARY_UPLOAD_ACCEPT = LIBRARY_SUPPORTED_EXTENSIONS.join(",");

export function libraryFileExtension(filename: string): string {
  const idx = filename.lastIndexOf(".");
  return idx > 0 ? filename.slice(idx).toLowerCase() : "";
}

export function isLibrarySupportedExtension(
  extension: string,
): extension is LibrarySupportedExtension {
  return SUPPORTED.has(extension.toLowerCase());
}

export function libraryExtractionKind(
  filename: string,
): "text" | "docling" | null {
  const extension = libraryFileExtension(filename);
  if (!isLibrarySupportedExtension(extension)) return null;
  return DIRECT_TEXT.has(extension) ? "text" : "docling";
}

export function doclingInputFormat(filename: string): string | null {
  const extension = libraryFileExtension(filename);
  if (!isLibrarySupportedExtension(extension) || DIRECT_TEXT.has(extension)) return null;
  return extension.slice(1);
}
