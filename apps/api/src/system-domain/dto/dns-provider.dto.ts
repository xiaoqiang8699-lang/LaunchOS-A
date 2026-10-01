import { IsString, MaxLength, MinLength } from 'class-validator';

export class BindDnsProviderDto {
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  providerAccountId!: string;
}
