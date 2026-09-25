<?php
// save_customer_csv.php
// Accepts raw CSV in the request body and writes it to ./data/customer.csv
// Supports append mode via query param ?append=1
// NOTE: This script trusts the caller. If deploying in production, add authentication and validation.

// Allow POST and OPTIONS for compatibility with some clients
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    header('Allow: POST, OPTIONS');
    header('Access-Control-Allow-Methods: POST, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type');
    header('Access-Control-Allow-Origin: *');
    http_response_code(200);
    echo 'OK';
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    header('Allow: POST, OPTIONS');
    echo 'METHOD_NOT_ALLOWED';
    exit;
}

$input = file_get_contents('php://input');
if ($input === false || $input === '') {
    http_response_code(400);
    echo 'NO_INPUT';
    exit;
}

// Normalize line endings and remove BOM
$input = preg_replace('/\r\n|\r/', "\n", $input);
$input = preg_replace('/^\xEF\xBB\xBF/', '', $input);

$target = __DIR__ . DIRECTORY_SEPARATOR . 'data' . DIRECTORY_SEPARATOR . 'customer.csv';
$append = (isset($_GET['append']) && ($_GET['append'] === '1' || $_GET['append'] === 'true'));

// If append mode and target exists, attempt to preserve existing header and avoid duplicating header
if ($append && file_exists($target)) {
    // create a backup of current file
    $bak = $target . '.bak_' . date('Ymd_His');
    @copy($target, $bak);

    // Read existing header (first non-empty line)
    $existing = file($target, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
    $existingHeader = null;
    if ($existing && count($existing) > 0) {
        $existingHeader = trim($existing[0]);
        $existingHeader = preg_replace('/^\xEF\xBB\xBF/', '', $existingHeader);
    }

    // Split input into lines and drop leading/trailing empty lines
    $lines = preg_split('/\n/', $input);
    $filtered = array_values(array_filter(array_map('trim', $lines), function($l){ return $l !== ''; }));

    if (count($filtered) === 0) {
        http_response_code(400);
        echo 'NO_INPUT_LINES';
        exit;
    }

    $inputHeader = $filtered[0];

    // Compare headers in a normalized manner
    $normalize = function($s) {
        $s = preg_replace('/^\xEF\xBB\xBF/', '', $s);
        $s = preg_replace('/\s+/', ' ', trim($s));
        return mb_strtolower($s);
    };

    $startIndex = 0;
    if ($existingHeader !== null && $normalize($existingHeader) === $normalize($inputHeader)) {
        // drop the header from input
        $startIndex = 1;
    }

    // Prepare content to append
    $toAppendLines = array_slice($filtered, $startIndex);
    if (count($toAppendLines) === 0) {
        // nothing to append
        header('Content-Type: text/plain; charset=utf-8');
        echo 'OK';
        exit;
    }

    $toAppend = implode("\n", $toAppendLines) . "\n";

    // Append atomically using file_put_contents with LOCK_EX
    if (file_put_contents($target, $toAppend, FILE_APPEND | LOCK_EX) === false) {
        http_response_code(500);
        echo 'APPEND_FAILED';
        exit;
    }

    header('Content-Type: text/plain; charset=utf-8');
    echo 'OK';
    exit;
}

// Non-append (overwrite) behavior
// Make a backup if file exists
if (file_exists($target)) {
    $bak = $target . '.bak_' . date('Ymd_His');
    @copy($target, $bak);
}

// Write atomically by writing to temp then rename
$tmp = $target . '.tmp';
if (file_put_contents($tmp, $input) === false) {
    http_response_code(500);
    echo 'WRITE_FAILED';
    exit;
}

if (!@rename($tmp, $target)) {
    // fallback: try direct write
    if (file_put_contents($target, $input) === false) {
        http_response_code(500);
        echo 'RENAME_FAILED';
        exit;
    }
}

header('Content-Type: text/plain; charset=utf-8');
echo 'OK';
