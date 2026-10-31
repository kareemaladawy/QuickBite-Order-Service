import { IsIn, IsInt, IsNumber, IsOptional, IsString, Min, MaxLength } from "class-validator";

export class PresenceOnlineRequestDTO {
    @IsNumber()
    lat!: number;

    @IsNumber()
    lng!: number;
}

export class AssignDeliveryRequestDTO {
    // Present -> manual: skips the broadcast/accept flow and writes `orders` directly.
    // Absent -> re-run the broadcast algorithm (same algorithm the `ready` hook and the
    // sweep worker use).
    @IsOptional()
    @IsInt()
    @Min(1)
    agentId?: number;
}

const DELIVERY_PATCHABLE_STATUSES = ["picked", "delivered"] as const;

export class UpdateDeliveryStatusRequestDTO {
    @IsIn(DELIVERY_PATCHABLE_STATUSES)
    status!: "picked" | "delivered";

    @IsOptional()
    @IsString()
    @MaxLength(500)
    reason?: string;
}
