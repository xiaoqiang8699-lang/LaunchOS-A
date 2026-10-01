import { IsString, MinLength } from 'class-validator';



export class PromoteRuntimeConfigDto {

  @IsString()

  @MinLength(1)

  unitId!: string;

}


