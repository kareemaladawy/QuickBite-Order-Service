import { container } from "../di/container";
import { TOKENS } from "../di/tokens";
import { logger } from "../logger/logger";
import { WsEmitter } from "./types";

// Resolved lazily (not imported/constructed eagerly) because the socket.io server is
// registered on TOKENS.WsServer in server.ts *after* the DI container has already
// resolved the services that need to publish — same reasoning as order.service.ts's
// private emitWs. Shared here so app/payment/* doesn't duplicate it.
export function publishToRoom(room: string, event: string, payload: unknown): void {
    try {
        const io = container.resolve<WsEmitter>(TOKENS.WsServer);
        io.to(room).emit(event, payload);
    } catch (err) {
        logger.warn("ws emit skipped (server not ready)", { room, event, error: (err as Error).message });
    }
}
