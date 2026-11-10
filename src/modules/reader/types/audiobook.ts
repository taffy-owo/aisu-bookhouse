export interface AudiobookPosition {
  paragraphIndex?: number;
  paragraphOffset?: number;
}

export interface AudiobookModeHandoff extends AudiobookPosition {
  chapterIndex: number;
  paused: boolean;
  followText: boolean;
  autoAdvance: boolean;
  playbackRate: number;
}

export interface AudiobookPlayRequest {
  chapterIndex: number;
  id: number;
  handoff?: AudiobookModeHandoff;
}
