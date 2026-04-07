export class FbaReplenishmentSkuDto {
  id!: string;
  sku!: string;
  productId!: string | null;
  productName!: string | null;
  fnsku?: string | null;
}

export class FbaReplenishmentBoxDto {
  id!: string;
  boxCode!: string;
  shelfCode!: string | null;
}

export class FbaReplenishmentUserDto {
  id!: string;
  username!: string;
}

export class FbaReplenishmentResponseDto {
  id!: string;
  requestNo!: string;
  status!: string;
  sku!: FbaReplenishmentSkuDto | null;
  box!: FbaReplenishmentBoxDto | null;
  requestedQty!: number;
  actualQty!: number | null;
  expressNo!: string | null;
  remark?: string | null;
  creator?: FbaReplenishmentUserDto | null;
  createdAt?: Date;
}
