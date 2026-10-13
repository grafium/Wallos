<?php
/*
  Regenerates src/ui/i18n/*.json from the PHP language files.
  php scripts/convert-i18n.php   (run from worker/)
*/
$root = realpath(__DIR__ . '/../..');
$out = $root . '/worker/src/ui/i18n';
require $root . '/includes/i18n/languages.php';
$meta = [];
foreach ($languages as $code => $info) {
    $i18n = [];
    require $root . "/includes/i18n/$code.php";
    file_put_contents("$out/$code.json", json_encode($i18n, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT) . "\n");
    $meta[$code] = $info;
}
file_put_contents("$out/languages.json", json_encode($meta, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT) . "\n");
echo count($meta) . " languages\n";
