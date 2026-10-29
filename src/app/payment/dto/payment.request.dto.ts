import { IsInt, IsOptional, IsString, IsUUID, Min, MinLength } from "class-validator";

export class InitPaymentRequestDTO {
    @IsUUID()
    orderId!: string; // order's public_id
}

export class RefundRequestDTO {
    @IsOptional()
    @IsInt()
    @Min(1)
    amount?: number; // minor units; omitted => full refund

    @IsString()
    @MinLength(3)
    reason!: string;
}
