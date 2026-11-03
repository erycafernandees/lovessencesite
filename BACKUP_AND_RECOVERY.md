# Cópias de segurança e recuperação da Love Essences

**Estado em 03/11/2026:** projeto Supabase no plano **Free**, sem backups diários geridos incluídos. **Ainda não existe backup externo automático.**

## Componentes

- Código e funções: histórico do GitHub.
- Pagamentos: os movimentos financeiros existem na Stripe.
- Base de dados: precisa de exportação cifrada e independente.
- Ficheiros privados: os objetos do Supabase Storage não estão incluídos num dump de PostgreSQL. Precisam de cópia própria.

## Exportação cifrada (preparada, não agendada)

O script `scripts/backup_encrypted.sh` exporta a base PostgreSQL e cifra-a usando a chave pública **age**, sem guardar credenciais ou chaves privadas no repositório.

Requisitos: `pg_dump`, `age`, uma pasta privada fora do GitHub, URL privada de base de dados e chave pública age.

Definir com segurança as variáveis `SUPABASE_DB_URL`, `BACKUP_AGE_RECIPIENT` e `BACKUP_DESTINATION` e executar `bash scripts/backup_encrypted.sh` localmente.

**Nunca colocar credenciais de base de dados, chaves privadas ou backups no GitHub ou nos registos de execução públicos.**

## Testar a recuperação

1. Confirmar que o ficheiro `.dump.age` é não vazio e foi guardado num serviço externo.
2. Desencriptar apenas num computador seguro com a chave privada age.
3. Validar `pg_restore --list recuperacao.dump` e testar a recuperação numa base separada.
4. Copiar e testar separadamente os anexos privados e as respetivas permissões no Storage.
5. Registar a data e o resultado do último teste.

## Próximo passo para automatizar

Confirmar um destino externo e privado e o mecanismo de acesso, sem introduzir credenciais no repositório público. O plano Supabase Pro oferece backups de base de dados geridos mediante subscrição, mas não substitui uma cópia externa dos objetos Storage.

**Este documento não cria backups nem novas subscrições.**