export interface CotRef {
  cotId: string;
  messageId: string;
}

export interface CotEvent {
  event_type: string;
  content: string;
  timestamp: number;
}
