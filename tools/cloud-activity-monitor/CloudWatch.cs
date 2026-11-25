using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Media;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
[assembly:System.Reflection.AssemblyVersion("0.1.0.0")]
public class Sample { public long at; public double count; }
public class FunctionSample:Sample { public string name; public double errors; }
public class Snapshot {
 public string status,project,note; public long collectedAt; public long? sampleAt;
 public string[] alerts,errors; public FunctionSample[] functions; public FunctionSample photo; public Sample reads,writes;
}
public class Preferences {public int left,top;public bool pin=true,sound=true;}
public class CloudWatch:Form {
 readonly string data;readonly bool demo;readonly JavaScriptSerializer json=new JavaScriptSerializer();
 readonly Label heading=new Label(),health=new Label(),rates=new Label(),fresh=new Label();
 readonly CheckBox pin=new CheckBox(),sound=new CheckBox();readonly Button expand=new Button();
 readonly TextBox details=new TextBox();readonly System.Windows.Forms.Timer timer=new System.Windows.Forms.Timer();
 readonly NotifyIcon tray=new NotifyIcon();Process collector;string previousStatus="";DateTime lastAlarm=DateTime.MinValue;bool expanded;
 static string Arg(string[] args,string key,string fallback){int i=Array.IndexOf(args,key);return i>=0&&i+1<args.Length?args[i+1]:fallback;}
 [STAThread] public static void Main(string[] args){
  bool demo=args.Contains("--demo"),created;using(var mutex=new Mutex(true,"Local\\WellBuilt.CloudWatch.Native"+(demo?".Demo":""),out created)){
   if(!created){MessageBox.Show("WB Cloud Watch is already open.");return;}
   Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);
   string data=Arg(args,"--data",Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"WellBuilt","CloudActivityMonitor"));
   Application.Run(new CloudWatch(Path.GetFullPath(data),demo));
  }
 }
 CloudWatch(string directory,bool isDemo){
  data=directory;demo=isDemo;Directory.CreateDirectory(data);
  Text="WB Cloud Watch"+(demo?" — DEMO":"");BackColor=Color.FromArgb(17,19,21);ForeColor=Color.Gainsboro;
  Font=new Font("Segoe UI",9);ClientSize=new Size(370,205);MinimumSize=new Size(340,240);TopMost=true;StartPosition=FormStartPosition.Manual;
  Rectangle work=Screen.PrimaryScreen.WorkingArea;Location=new Point(work.Right-Width-16,work.Top+40);
  var grid=new TableLayoutPanel{Dock=DockStyle.Fill,Padding=new Padding(12),ColumnCount=1,RowCount=6};
  foreach(float h in new[]{23f,40f,50f,24f})grid.RowStyles.Add(new RowStyle(SizeType.Absolute,h));
  grid.RowStyles.Add(new RowStyle(SizeType.Percent,100));grid.RowStyles.Add(new RowStyle(SizeType.Absolute,29));Controls.Add(grid);
  var top=new Panel{Dock=DockStyle.Fill};heading.Text="WB CLOUD WATCH"+(demo?" · DEMO":"");heading.ForeColor=Color.FromArgb(232,188,76);heading.Font=new Font(Font,FontStyle.Bold);heading.AutoSize=true;top.Controls.Add(heading);
  pin.Text="Pin";pin.AutoSize=true;pin.Dock=DockStyle.Right;pin.Checked=true;pin.CheckedChanged+=(s,e)=>TopMost=pin.Checked;top.Controls.Add(pin);grid.Controls.Add(top,0,0);
  health.Font=new Font("Segoe UI",17,FontStyle.Bold);health.Dock=DockStyle.Fill;health.Text="Waiting for metrics…";grid.Controls.Add(health,0,1);
  rates.Dock=DockStyle.Fill;rates.Text="Loading…";grid.Controls.Add(rates,0,2);
  fresh.Dock=DockStyle.Fill;fresh.ForeColor=Color.DarkGray;fresh.Font=new Font("Segoe UI",8);grid.Controls.Add(fresh,0,3);
  details.Multiline=true;details.ReadOnly=true;details.ScrollBars=ScrollBars.Vertical;details.Dock=DockStyle.Fill;details.BackColor=BackColor;details.ForeColor=ForeColor;details.BorderStyle=BorderStyle.None;details.Visible=false;grid.Controls.Add(details,0,4);
  var bottom=new FlowLayoutPanel{Dock=DockStyle.Fill};expand.Text="Details";expand.AutoSize=true;expand.Height=25;expand.Click+=(s,e)=>{expanded=!expanded;details.Visible=expanded;Height=expanded?440:245;expand.Text=expanded?"Less":"Details";};bottom.Controls.Add(expand);
  sound.Text="Sound";sound.AutoSize=true;sound.Checked=!demo;sound.Margin=new Padding(12,5,0,0);bottom.Controls.Add(sound);grid.Controls.Add(bottom,0,5);
  tray.Icon=SystemIcons.Information;tray.Text="WB Cloud Watch";tray.Visible=!demo;tray.DoubleClick+=(s,e)=>{Show();WindowState=FormWindowState.Normal;Activate();};
  Load+=(s,e)=>{LoadPreferences();if(!demo)StartCollector();RefreshStatus();};
  FormClosed+=(s,e)=>{timer.Stop();tray.Dispose();SavePreferences();try{if(collector!=null&&!collector.HasExited)collector.Kill();}catch{};};
  timer.Interval=3000;timer.Tick+=(s,e)=>RefreshStatus();timer.Start();
 }
 void StartCollector(){
  try{string script=Path.Combine(Application.StartupPath,"collector.cjs");if(!File.Exists(script))throw new IOException();
   collector=new Process{StartInfo=new ProcessStartInfo("node.exe","\""+script+"\" \""+data+"\""){UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true}};
   collector.OutputDataReceived+=(s,e)=>{};collector.ErrorDataReceived+=(s,e)=>{};collector.Start();collector.BeginOutputReadLine();collector.BeginErrorReadLine();
  }catch{details.Text="Collector unavailable. Node and this Windows user's Firebase CLI sign-in are required.";}
 }
 static DateTime At(long ms){return new DateTime(1970,1,1,0,0,0,DateTimeKind.Utc).AddMilliseconds(ms);}
 static string Count(Sample x){return x==null?"—":x.count.ToString("N0");}
 void RefreshStatus(){
  try{var s=json.Deserialize<Snapshot>(File.ReadAllText(Path.Combine(data,"status.json")));double age=(DateTime.UtcNow-At(s.collectedAt)).TotalSeconds;
   string status=age>150?"STALE":s.status;Color color=status=="NORMAL"?Color.FromArgb(82,199,136):status=="CRITICAL"?Color.FromArgb(255,98,98):status=="WARNING"?Color.FromArgb(240,190,70):Color.Silver;
   health.Text=status=="NORMAL"?"Activity normal":status=="CRITICAL"?"ACTIVITY SPIKE":status=="WARNING"?"High activity":status=="STALE"?"Monitor is offline":status=="NO_RECENT_DATA"?"No recent metrics":"Metrics unavailable";health.ForeColor=color;
   string cause=s.alerts!=null&&s.alerts.Length>0?s.alerts[0]+Environment.NewLine:"";
   rates.Text=cause+"Photo fallback: "+(s.photo==null?"No recent traffic":Count(s.photo)+"/min")+Environment.NewLine+"Firestore: "+Count(s.reads)+" reads · "+Count(s.writes)+" writes /min";
   fresh.Text="Cloud sample: "+(s.sampleAt.HasValue?At(s.sampleAt.Value).ToLocalTime().ToString("h:mm tt"):"not available")+" · checked "+Math.Max(0,(int)age)+"s ago";
   var lines=new List<string>{"wellbuilt-sync · read-only","Google metrics can lag by several minutes.",""};
   lines.AddRange(s.alerts??new string[0]);lines.AddRange(s.errors??new string[0]);foreach(var f in s.functions??new FunctionSample[0])lines.Add(f.name+": "+f.count.ToString("N0")+"/min ("+f.errors+" server errors)");details.Text=String.Join(Environment.NewLine,lines);
   if(!demo&&sound.Checked&&status=="CRITICAL"&&(previousStatus!="CRITICAL"||(DateTime.Now-lastAlarm).TotalMinutes>=5)){
    SystemSounds.Exclamation.Play();tray.ShowBalloonTip(5000,"WB Cloud Watch: activity spike",cause.Trim(),ToolTipIcon.Warning);lastAlarm=DateTime.Now;
   }previousStatus=status;
  }catch{health.Text="Waiting for metrics…";health.ForeColor=Color.Silver;rates.Text="No live status is being claimed.";fresh.Text="Read-only · refresh every minute";}
 }
 void LoadPreferences(){if(demo)return;try{var p=json.Deserialize<Preferences>(File.ReadAllText(Path.Combine(data,"window.json")));pin.Checked=p.pin;sound.Checked=p.sound;Rectangle area=SystemInformation.VirtualScreen;if(area.Contains(new Point(p.left,p.top)))Location=new Point(p.left,p.top);}catch{}}
 void SavePreferences(){if(demo)return;try{File.WriteAllText(Path.Combine(data,"window.json"),json.Serialize(new Preferences{left=Left,top=Top,pin=pin.Checked,sound=sound.Checked}));}catch{}}
}
