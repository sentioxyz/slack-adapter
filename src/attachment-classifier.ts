// Pure classification of Slack files into delivery categories.
import type { SlackFileInfo, AttachmentCategory } from "./types.js";
import { isAudioClip, isTextFile } from "./utils.js";

export function classifyAttachment(
  file: SlackFileInfo,
  opts: { inlineMaxBytes: number },
): AttachmentCategory {
  if (isAudioClip(file)) return "audio";
  if (isTextFile(file)) {
    return (file.size ?? 0) <= opts.inlineMaxBytes ? "text-inline" : "text-file";
  }
  return "binary";
}
