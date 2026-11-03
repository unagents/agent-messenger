export declare const SUCCESS_MARKER: RegExp;
export declare function outputsToRemoveOnFailure(root: string, target: string): string[];
export declare function checkStripDedup(text: string): {
  ok: boolean;
  problems: string[];
  stripDedupLines: string[];
};
