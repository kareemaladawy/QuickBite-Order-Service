export type Cluster = "hot" | "archive";

export interface ShardPing {
    region: string;
    cluster: Cluster;
    ok: boolean;
    error?: string;
}

export interface MonthPartitionBound {
    name: string;
    from: string; // YYYY-MM-DD
    to: string;   // YYYY-MM-DD, exclusive
}
