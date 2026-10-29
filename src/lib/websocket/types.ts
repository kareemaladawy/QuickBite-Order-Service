export interface WsEmitter {
    to(room: string): { emit(event: string, payload: unknown): void };
}
