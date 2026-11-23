# dsh-habblaud-uso

Plugin (bundle) do DeepSeek Harness que passa ao Habblaud o **saldo do DeepSeek** que o plugin
`dsh-cost-meter` já consulta. Não lê chave nenhuma e não vai à rede: a cada 60 s pede ao
serviço `costMeter` o estado local (`getLocalState()`) e grava só os números do saldo em
`<DSH_HOME>/storages/habblaud/balance.json`. O Habblaud lê esse arquivo e mostra o saldo no cartão da conta do
DeepSeek Harness (os tokens e o custo ele já lê direto do livro-caixa do cost-meter).

Precisa do dsh-cost-meter instalado e com a consulta de saldo ligada.

## Instalar

No DeepSeek Harness: **Plugins** > **Adicionar plugin** > pasta local, e escolha esta pasta
(`mod/dsh-habblaud-uso`). Ou crie um link em `~/.dsh/profiles/<perfil>/node_modules/@habblaud/dsh-habblaud-uso`
apontando para ela e reinicie o DSH.

`config.dir` na linha do plugin muda a pasta do arquivo (o Habblaud usa `HABBLAUD_DSH_BALANCE` para o caminho).
