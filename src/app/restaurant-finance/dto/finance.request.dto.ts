import { IsEnum, IsInt, IsOptional, IsString, Min, MinLength } from "class-validator";

enum Currency {
    EGP = "EGP",
    SAR = "SAR",
}

export class CreatePayoutRequestDTO {
    @IsInt()
    @Min(1)
    restaurantId!: number;

    @IsInt()
    @Min(1)
    amount!: number;

    @IsEnum(Currency)
    currency!: Currency;

    @IsString()
    @MinLength(1)
    providerReferenceId!: string;

    @IsOptional()
    @IsString()
    note?: string;
}
