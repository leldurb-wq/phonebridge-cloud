Set shell = CreateObject("WScript.Shell")
shell.Run """" & WScript.Arguments(0) & """ """ & WScript.Arguments(1) & """", 0, False
