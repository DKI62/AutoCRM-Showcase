# Isolated in-memory regression engine. Uses the Windows SQLite C API, never an app database.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class NativeSQLite {
  [DllImport("winsqlite3", CallingConvention=CallingConvention.Cdecl)] public static extern int sqlite3_open(string name, out IntPtr db);
  [DllImport("winsqlite3", CallingConvention=CallingConvention.Cdecl)] public static extern int sqlite3_close(IntPtr db);
  [DllImport("winsqlite3", CallingConvention=CallingConvention.Cdecl)] public static extern IntPtr sqlite3_libversion();
  [DllImport("winsqlite3", CallingConvention=CallingConvention.Cdecl)] public static extern IntPtr sqlite3_errmsg(IntPtr db);
  [DllImport("winsqlite3", CallingConvention=CallingConvention.Cdecl)] public static extern int sqlite3_exec(IntPtr db, byte[] sql, IntPtr callback, IntPtr arg, IntPtr error);
  [DllImport("winsqlite3", CallingConvention=CallingConvention.Cdecl)] public static extern int sqlite3_prepare_v2(IntPtr db, byte[] sql, int length, out IntPtr statement, IntPtr tail);
  [DllImport("winsqlite3", CallingConvention=CallingConvention.Cdecl)] public static extern int sqlite3_bind_null(IntPtr statement, int index);
  [DllImport("winsqlite3", CallingConvention=CallingConvention.Cdecl)] public static extern int sqlite3_bind_int64(IntPtr statement, int index, long value);
  [DllImport("winsqlite3", CallingConvention=CallingConvention.Cdecl)] public static extern int sqlite3_bind_text(IntPtr statement, int index, byte[] value, int length, IntPtr destructor);
  [DllImport("winsqlite3", CallingConvention=CallingConvention.Cdecl)] public static extern int sqlite3_step(IntPtr statement);
  [DllImport("winsqlite3", CallingConvention=CallingConvention.Cdecl)] public static extern int sqlite3_finalize(IntPtr statement);
  [DllImport("winsqlite3", CallingConvention=CallingConvention.Cdecl)] public static extern int sqlite3_column_count(IntPtr statement);
  [DllImport("winsqlite3", CallingConvention=CallingConvention.Cdecl)] public static extern IntPtr sqlite3_column_name(IntPtr statement, int index);
  [DllImport("winsqlite3", CallingConvention=CallingConvention.Cdecl)] public static extern int sqlite3_column_type(IntPtr statement, int index);
  [DllImport("winsqlite3", CallingConvention=CallingConvention.Cdecl)] public static extern long sqlite3_column_int64(IntPtr statement, int index);
  [DllImport("winsqlite3", CallingConvention=CallingConvention.Cdecl)] public static extern IntPtr sqlite3_column_text(IntPtr statement, int index);
  [DllImport("winsqlite3", CallingConvention=CallingConvention.Cdecl)] public static extern int sqlite3_changes(IntPtr db);
  [DllImport("winsqlite3", CallingConvention=CallingConvention.Cdecl)] public static extern long sqlite3_last_insert_rowid(IntPtr db);
  public static byte[] Utf8(string value) { return Encoding.UTF8.GetBytes(value + "\0"); }
}
"@
$db = [IntPtr]::Zero
if ([NativeSQLite]::sqlite3_open(':memory:', [ref]$db) -ne 0) { throw 'Cannot open fixture' }
function Check([int]$code) { if ($code -ne 0) { throw [Runtime.InteropServices.Marshal]::PtrToStringUTF8([NativeSQLite]::sqlite3_errmsg($db)) } }
try {
  [Console]::WriteLine((@{version=[Runtime.InteropServices.Marshal]::PtrToStringUTF8([NativeSQLite]::sqlite3_libversion())} | ConvertTo-Json -Compress))
  while ($null -ne ($line = [Console]::ReadLine())) {
    try {
      $request = $line | ConvertFrom-Json
      if ($request.op -eq 'exec') {
        Check ([NativeSQLite]::sqlite3_exec($db, [NativeSQLite]::Utf8($request.sql), [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero))
        $value = $null
      } else {
        $statement = [IntPtr]::Zero
        Check ([NativeSQLite]::sqlite3_prepare_v2($db, [NativeSQLite]::Utf8($request.sql), -1, [ref]$statement, [IntPtr]::Zero))
        try {
          $index = 1
          foreach ($item in $request.args) {
            if ($null -eq $item) { Check ([NativeSQLite]::sqlite3_bind_null($statement, $index)) }
            elseif ($item -is [string]) { $bytes=[Text.Encoding]::UTF8.GetBytes($item); Check ([NativeSQLite]::sqlite3_bind_text($statement,$index,$bytes,$bytes.Length,[IntPtr]::new(-1))) }
            else { Check ([NativeSQLite]::sqlite3_bind_int64($statement,$index,[long]$item)) }
            $index++
          }
          $rows = [Collections.Generic.List[object]]::new()
          while (($status = [NativeSQLite]::sqlite3_step($statement)) -eq 100) {
            $row = @{}
            for ($column=0; $column -lt [NativeSQLite]::sqlite3_column_count($statement); $column++) {
              $name=[Runtime.InteropServices.Marshal]::PtrToStringUTF8([NativeSQLite]::sqlite3_column_name($statement,$column))
              $type=[NativeSQLite]::sqlite3_column_type($statement,$column)
              $row[$name] = if ($type -eq 5) { $null } elseif ($type -eq 1) { [NativeSQLite]::sqlite3_column_int64($statement,$column) } else { [Runtime.InteropServices.Marshal]::PtrToStringUTF8([NativeSQLite]::sqlite3_column_text($statement,$column)) }
            }
            $rows.Add($row)
          }
          if ($status -ne 101) { Check $status }
          $value = if ($request.op -eq 'run') { @{ changes=[NativeSQLite]::sqlite3_changes($db); lastInsertRowId=[NativeSQLite]::sqlite3_last_insert_rowid($db) } } else { ,$rows.ToArray() }
        } finally { [void][NativeSQLite]::sqlite3_finalize($statement) }
      }
      [Console]::WriteLine((@{value=$value} | ConvertTo-Json -Compress -Depth 12))
    } catch { [Console]::WriteLine((@{error=$_.Exception.Message} | ConvertTo-Json -Compress)) }
  }
} finally { [void][NativeSQLite]::sqlite3_close($db) }
