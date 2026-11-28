import { ApiError } from "./core.ts";

export function customerNif(input: unknown): string | null {
  if (input == null || input === "") return null;
  const nif = String(input).trim();
  const sum = [...nif.slice(0, 8)].reduce((n, digit, index) => n + Number(digit) * (9 - index), 0);
  const check = (11 - sum % 11) % 11;
  if (!/^[1-9][0-9]{8}$/.test(nif) || Number(nif[8]) !== (check === 10 ? 0 : check))
    throw new ApiError(422, "invalid_nif", "Confirma os nove dígitos do NIF.");
  return nif;
}
