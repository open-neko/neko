/**
 * Executable identity shipped by the OpenNeko agent image.
 *
 * OpenShell binds model egress to /proc/<pid>/exe, so this is part of the
 * vendored runtime contract, not an installation setting. The release smoke
 * compares it with Hermes' resolved interpreter inside the published image.
 */
export const VENDORED_HERMES_MODEL_BINARY = "/usr/bin/python3.11";
