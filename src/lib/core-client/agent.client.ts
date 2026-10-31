import { coreClient } from "./core-client";
import { cacheProvider } from "../cache/init";
import { toSeconds } from "../../pkg/utils/time";
import { CoreEnvelope, InternalAgentDTO } from "./types";

const AGENT_CACHE_TTL_SEC = toSeconds(10, "m");

function agentCacheKey(agentId: number): string {
    return `core:agent:${agentId}`;
}

// Read-through cache — an agent's name/phone is display-only enrichment on delivery
// WS events (agents.md §15), not something invalidated by a core-event handler like
// branch/restaurant are (no `agent.updated` binding is consumed in this milestone).
export async function getAgent(agentId: number, correlationId?: string): Promise<InternalAgentDTO> {
    const key = agentCacheKey(agentId);
    const cached = await cacheProvider.get(key);
    if (cached) return JSON.parse(cached) as InternalAgentDTO;

    const res = await coreClient.request<CoreEnvelope<InternalAgentDTO>>({
        method: "GET",
        path: `/api/v1/internal/agents/${agentId}`,
        correlationId,
    });

    await cacheProvider.set(key, JSON.stringify(res.data), AGENT_CACHE_TTL_SEC);
    return res.data;
}
