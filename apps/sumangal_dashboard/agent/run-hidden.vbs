' Runs the agent with no window (the scheduled tasks start this through wscript.exe).
'   wscript run-hidden.vbs run            the nightly run
'   wscript run-hidden.vbs day --until=21:00
Dim sh, fso, dir, args, i
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
args = ""
For i = 0 To WScript.Arguments.Count - 1
  args = args & " " & WScript.Arguments(i)
Next
sh.CurrentDirectory = dir
WScript.Quit sh.Run("""" & dir & "\node\node.exe"" --no-warnings """ & dir & "\agent.mjs""" & args, 0, True)
