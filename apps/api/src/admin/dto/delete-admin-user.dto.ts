import { IsEmail, IsString, MinLength } from 'class-validator';

export class DeleteAdminUserDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(1)
  phrase!: string;
}
