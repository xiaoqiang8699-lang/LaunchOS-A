import { IsString, MinLength } from 'class-validator';

export class InitializeServerDto {
  @IsString()
  @MinLength(8)
  serverInstanceId!: string;
}
