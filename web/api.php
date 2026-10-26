<?php
// Cobra o Pix de R$ 27,90 pelo Asaas e confirma o pagamento.
// Nenhuma lista de seguidores passa por aqui: o cruzamento é todo no navegador.
// A chave do Asaas fica no .env um nível acima da pasta pública.
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

const VALOR = 27.90;
$env = parse_ini_file(dirname(__DIR__) . '/.env') ?: [];

function sai(int $code, array $d): never
{
    http_response_code($code);
    echo json_encode($d, JSON_UNESCAPED_UNICODE);
    exit;
}

function asaas(string $metodo, string $caminho, ?array $corpo = null): array
{
    global $env;
    $ch = curl_init(rtrim($env['ASAAS_API_URL'], '/') . '/v3' . $caminho);
    curl_setopt_array($ch, [
        CURLOPT_CUSTOMREQUEST => $metodo,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 20,
        CURLOPT_HTTPHEADER => [
            'access_token: ' . $env['ASAAS_API_KEY'],
            'Content-Type: application/json',
            'User-Agent: seguidores.cwsystems.com.br',
        ],
    ]);
    if ($corpo !== null) {
        curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($corpo));
    }
    $resp = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);
    $d = json_decode((string) $resp, true) ?: [];
    if ($code >= 400 || $resp === false) {
        error_log('seguidores asaas ' . $metodo . ' ' . $caminho . ' ' . $code . ' ' . substr((string) $resp, 0, 300));
        sai(502, ['erro' => $d['errors'][0]['description'] ?? 'O banco não respondeu. Tente de novo em instantes.']);
    }
    return $d;
}

// o token amarra o id da cobrança a este site: /status não vira consulta de qualquer cobrança da conta
function assina(string $id): string
{
    global $env;
    return hash_hmac('sha256', $id, $env['SEGREDO']);
}

function cpfValido(string $c): bool
{
    if (strlen($c) !== 11 || preg_match('/^(\d)\1{10}$/', $c)) {
        return false;
    }
    for ($t = 9; $t < 11; $t++) {
        $s = 0;
        for ($i = 0; $i < $t; $i++) {
            $s += (int) $c[$i] * ($t + 1 - $i);
        }
        if ((int) $c[$t] !== ((10 * $s) % 11) % 10) {
            return false;
        }
    }
    return true;
}

$acao = $_GET['acao'] ?? '';

if ($acao === 'cobrar' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    $in = json_decode((string) file_get_contents('php://input'), true) ?: [];
    $nome = trim(mb_substr((string) ($in['nome'] ?? ''), 0, 80));
    $cpf = preg_replace('/\D/', '', (string) ($in['cpf'] ?? ''));
    $conta = substr(preg_replace('/[^a-z0-9._]/', '', strtolower((string) ($in['conta'] ?? ''))), 0, 30);
    if (mb_strlen($nome) < 3) {
        sai(422, ['erro' => 'Escreva seu nome.']);
    }
    if (!cpfValido($cpf)) {
        sai(422, ['erro' => 'Confira o CPF, ele não parece válido.']);
    }

    // reaproveita o cliente se o CPF já existe na conta (é a mesma pessoa)
    $achados = asaas('GET', '/customers?cpfCnpj=' . $cpf);
    $cliente = $achados['data'][0]['id']
        ?? asaas('POST', '/customers', ['name' => $nome, 'cpfCnpj' => $cpf, 'notificationDisabled' => true])['id'];

    $cobranca = asaas('POST', '/payments', [
        'customer' => $cliente,
        'billingType' => 'PIX',
        'value' => VALOR,
        'dueDate' => date('Y-m-d'),
        'description' => 'Quem não me segue' . ($conta ? " (@$conta)" : ''),
        // prefixo próprio: o webhook do Petfolio (mesma conta Asaas) ignora o que não reconhece
        'externalReference' => 'seguidores_' . ($conta ?: 'conta'),
    ]);
    $qr = asaas('GET', '/payments/' . $cobranca['id'] . '/pixQrCode');

    sai(200, [
        'id' => $cobranca['id'],
        'token' => assina($cobranca['id']),
        'imagem' => $qr['encodedImage'],
        'copiaecola' => $qr['payload'],
    ]);
}

if ($acao === 'status') {
    $id = (string) ($_GET['id'] ?? '');
    if (!preg_match('/^pay_[A-Za-z0-9]+$/', $id) || !hash_equals(assina($id), (string) ($_GET['token'] ?? ''))) {
        sai(403, ['erro' => 'Cobrança desconhecida.']);
    }
    $p = asaas('GET', '/payments/' . $id);
    sai(200, ['pago' => in_array($p['status'] ?? '', ['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'], true)]);
}

sai(404, ['erro' => 'Não encontrado.']);
