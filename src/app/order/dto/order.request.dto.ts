import { Type } from "class-transformer";
import {
    ArrayMinSize,
    IsEnum,
    IsIn,
    IsInt,
    IsOptional,
    IsString,
    Min,
    MinLength,
    ValidateIf,
    ValidateNested,
} from "class-validator";
import { OrderStatus, PaymentMethod } from "../enums";

export class CreateOrderItemRequestDTO {
    @IsInt()
    @Min(1)
    productId!: number;

    @IsInt()
    @Min(1)
    quantity!: number;
}

export class CreateOrderRequestDTO {
    @IsInt()
    @Min(1)
    branchId!: number;

    @IsInt()
    @Min(1)
    customerAddressId!: number;

    @IsEnum(PaymentMethod)
    paymentMethod!: PaymentMethod;

    @ValidateNested({ each: true })
    @Type(() => CreateOrderItemRequestDTO)
    @ArrayMinSize(1)
    items!: CreateOrderItemRequestDTO[];
}

// Only the statuses the server-side status machine ever lets a client *request* —
// `placed` and `assigned` are system-only writes, never a PATCH target.
const PATCHABLE_STATUSES = [
    OrderStatus.ACCEPTED,
    OrderStatus.REJECTED,
    OrderStatus.PREPARING,
    OrderStatus.READY,
    OrderStatus.PICKED,
    OrderStatus.DELIVERED,
    OrderStatus.CANCELLED,
];

export class UpdateOrderStatusRequestDTO {
    @IsIn(PATCHABLE_STATUSES)
    status!: OrderStatus;

    @ValidateIf((dto: UpdateOrderStatusRequestDTO) => dto.status === OrderStatus.CANCELLED)
    @IsString()
    @MinLength(3)
    reason?: string;
}
