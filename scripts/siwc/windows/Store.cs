using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;

// Windows PowerShell 5.1/.NET Framework. No credentials in arguments or diagnostics.
public static class DailyLogStore {
 [StructLayout(LayoutKind.Sequential)] struct Info {
  public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Created,Accessed,Written;
  public uint Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow;
 }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
 static extern SafeFileHandle CreateFile(string name,uint access,uint share,IntPtr security,uint mode,uint flags,IntPtr template);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle file,out Info info);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool MoveFileEx(string from,string to,uint flags);
 [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes {public int Length; public IntPtr Descriptor; [MarshalAs(UnmanagedType.Bool)] public bool Inherit;}
 [DllImport("kernel32.dll",EntryPoint="CreateFileW",CharSet=CharSet.Unicode,SetLastError=true)]
 static extern SafeFileHandle CreateSecureFile(string name,uint access,uint share,ref SecurityAttributes security,uint mode,uint flags,IntPtr template);
 static readonly SecurityIdentifier User=WindowsIdentity.GetCurrent().User;
 static readonly byte[] Entropy=Encoding.UTF8.GetBytes("daily-log-siwc/windows/v1");
 static void Require(bool ok) { if(!ok) throw new IOException("STORAGE_UNSAFE"); }
 static Info Inspect(SafeFileHandle h,bool directory) {
  Info i=new Info(); Require(!h.IsInvalid && GetFileInformationByHandle(h,out i));
  Require((i.Attributes & 0x400)==0 && ((i.Attributes & 0x10)!=0)==directory);
  if(!directory) Require(i.Links==1 && i.SizeHigh==0 && i.SizeLow<=131072);
  return i;
 }
 static void CheckAcl(string path,bool directory) {
  FileSystemSecurity acl=directory?(FileSystemSecurity)Directory.GetAccessControl(path):File.GetAccessControl(path);
  Require(acl.GetOwner(typeof(SecurityIdentifier)).Equals(User));
  if(directory) Require(acl.AreAccessRulesProtected);
  bool own=false;
  foreach(FileSystemAccessRule r in acl.GetAccessRules(true,true,typeof(SecurityIdentifier))) {
   // Refuse extra principals, deny entries, and inherited broad permissions.
   Require(r.IdentityReference.Equals(User) && r.AccessControlType==AccessControlType.Allow);
   if((r.FileSystemRights & FileSystemRights.FullControl)==FileSystemRights.FullControl) own=true;
  }
  Require(own);
 }
 static DirectorySecurity PrivateAcl() {
  var acl=new DirectorySecurity();acl.SetOwner(User);acl.SetAccessRuleProtection(true,false);
  acl.AddAccessRule(new FileSystemAccessRule(User,FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));return acl;
 }
 static List<SafeFileHandle> Pin(string dir) {
  Require(System.Text.RegularExpressions.Regex.IsMatch(dir,@"^[A-Za-z]:\\") && !dir.Substring(2).Contains(":"));
  Require(Path.GetFullPath(dir)==dir && dir.Length<240);
  string root=Path.GetPathRoot(dir);var drive=new DriveInfo(root);
  Require(drive.DriveType==DriveType.Fixed && drive.DriveFormat=="NTFS");
  var pins=new List<SafeFileHandle>();
  try {
   string current=root;
   var components=new List<string>();components.Add(root);
   foreach(string part in dir.Substring(root.Length).Split('\\')) {Require(part.Length>0 && !part.EndsWith(".") && !part.EndsWith(" "));current=Path.Combine(current,part);components.Add(current);}
   for(int n=0;n<components.Count;n++) {
    string path=components[n];
    if(n==components.Count-1 && !Directory.Exists(path)) Directory.CreateDirectory(path,PrivateAcl());
    // Each ancestor remains pinned without FILE_SHARE_DELETE until the transaction ends.
    var h=CreateFile(path,0x80,3,IntPtr.Zero,3,0x02200000,IntPtr.Zero);pins.Add(h);Inspect(h,true);
   }
   CheckAcl(dir,true);return pins;
  } catch {foreach(var h in pins)h.Dispose();throw;}
 }
 static FileStream Open(string path,uint mode,bool optional=false) {
  SafeFileHandle h;
  if(mode==1 || mode==4) {
   var acl=new FileSecurity();acl.SetOwner(User);acl.SetAccessRuleProtection(true,false);
   acl.AddAccessRule(new FileSystemAccessRule(User,FileSystemRights.FullControl,AccessControlType.Allow));
   var descriptor=GCHandle.Alloc(acl.GetSecurityDescriptorBinaryForm(),GCHandleType.Pinned);
   try {
    var sa=new SecurityAttributes();sa.Length=Marshal.SizeOf(typeof(SecurityAttributes));sa.Descriptor=descriptor.AddrOfPinnedObject();
    h=CreateSecureFile(path,0xC0000000,0,ref sa,mode,0x00200000,IntPtr.Zero);
   } finally {descriptor.Free();}
  } else h=CreateFile(path,0xC0000000,0,IntPtr.Zero,mode,0x00200000,IntPtr.Zero);
  if(h.IsInvalid && optional && Marshal.GetLastWin32Error()==2){h.Dispose();return null;}
  try {Inspect(h,false);CheckAcl(path,false);return new FileStream(h,FileAccess.ReadWrite);}
  catch {h.Dispose();throw;}
 }
 static string Name(string dir,string name) {Require(name=="host.json" || name=="session.json");return Path.Combine(dir,name);}
 static byte[] Read(string path) {
  using(var f=Open(path,3,true)) {
   if(f==null)return null;
   var bytes=new byte[f.Length];int pos=0,n;
   while(pos<bytes.Length && (n=f.Read(bytes,pos,bytes.Length-pos))>0)pos+=n;
   Require(pos==bytes.Length);return ProtectedData.Unprotect(bytes,Entropy,DataProtectionScope.CurrentUser);
  }
 }
 static void Write(string path,byte[] value) {
  Require(value.Length<=65536);
  using(var existing=Open(path,3,true)){}
  byte[] cipher=ProtectedData.Protect(value,Entropy,DataProtectionScope.CurrentUser);
  string temp=path+"."+Guid.NewGuid().ToString("N")+".tmp";
  try {
   using(var f=Open(temp,1)) {f.Write(cipher,0,cipher.Length);f.Flush(true);}
   Require(MoveFileEx(temp,path,0x1|0x8)); // same-directory replace, write-through; never truncate old value
  } finally {if(File.Exists(temp))File.Delete(temp);Array.Clear(cipher,0,cipher.Length);}
 }
 public static void Run() {
  List<SafeFileHandle> pins=null;FileStream locked=null;
  try {
   string line=Console.ReadLine();Require(line!=null && line.Length<8192);
   string dir=Encoding.UTF8.GetString(Convert.FromBase64String(line));
   pins=Pin(dir);locked=Open(Path.Combine(dir,".lock"),4); // OPEN_ALWAYS + exclusive OS lock; crash releases handle
   Console.WriteLine("READY");Console.Out.Flush();
   while((line=Console.ReadLine())!=null) {
    Require(line.Length<100000);var parts=line.Split(new char[]{' '},3);
    Require(parts.Length>=2);string path=Name(dir,parts[1]);
    if(parts[0]=="R" && parts.Length==2) {
     byte[] value=Read(path);Console.WriteLine(value==null?"NULL":"VALUE "+Convert.ToBase64String(value));
     if(value!=null)Array.Clear(value,0,value.Length);
    } else if(parts[0]=="W" && parts.Length==3) {
     byte[] value=Convert.FromBase64String(parts[2]);try{Write(path,value);}finally{Array.Clear(value,0,value.Length);}Console.WriteLine("OK");
    } else if(parts[0]=="D" && parts.Length==2 && parts[1]=="session.json") {
     bool exists;using(var f=Open(path,3,true)){exists=f!=null;} if(exists)File.Delete(path);Console.WriteLine("OK");
    } else throw new IOException("PROTOCOL_INVALID");
    Console.Out.Flush();
   }
  } catch {Console.WriteLine("ERROR STORAGE_UNSAFE_OR_BUSY");Console.Out.Flush();Environment.ExitCode=1;}
  finally {if(locked!=null)locked.Dispose();if(pins!=null)foreach(var h in pins)h.Dispose();}
 }
}
