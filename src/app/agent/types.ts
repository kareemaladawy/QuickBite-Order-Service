// A ranked broadcast candidate — distance from GEOSEARCH, load from presence:load,
// combined into the agents.md §3 scoring formula.
export interface AssignmentCandidate {
    agentId: number;
    distanceMeters: number;
    loadCount: number;
    score: number;
}

export interface EarningsRange {
    from: Date;
    to: Date;
}
