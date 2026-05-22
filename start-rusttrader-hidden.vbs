Set fso = CreateObject("Scripting.FileSystemObject")
Set WshShell = CreateObject("WScript.Shell")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
batPath = scriptDir & "\start-rusttrader.bat"

WshShell.Run "cmd.exe /c """ & batPath & """", 0, False
