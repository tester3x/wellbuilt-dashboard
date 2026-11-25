param([string]$DataDir=(Join-Path $env:LOCALAPPDATA 'WellBuilt\CloudActivityMonitor'),[switch]$Demo)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName PresentationFramework,PresentationCore,WindowsBase,System.Windows.Forms
$mutex=New-Object Threading.Mutex($false,('Local\WellBuiltCloudWatch'+$(if($Demo){'Demo'}else{''})))
if(-not $mutex.WaitOne(0)){[System.Windows.MessageBox]::Show('WB Cloud Watch is already open.')|Out-Null;exit}
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
$collector=$null
try{
 if(-not $Demo){
  $node=(Get-Command node.exe).Source
  $collector=Start-Process -FilePath $node -ArgumentList @(('"'+(Join-Path $PSScriptRoot 'collector.cjs')+'"'),('"'+$DataDir+'"')) -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $DataDir 'collector.log') -RedirectStandardError (Join-Path $DataDir 'collector-error.log')
 }
 [xml]$xaml=@'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" Title="WB Cloud Watch" Width="380" Height="242" MinWidth="330" MinHeight="220" WindowStyle="ToolWindow" ResizeMode="CanResizeWithGrip" Topmost="True" Background="#111315" Foreground="#EEEEEE" FontFamily="Segoe UI">
 <Border Name="Frame" BorderBrush="#777777" BorderThickness="3" Padding="12">
  <Grid><Grid.RowDefinitions><RowDefinition Height="Auto"/><RowDefinition Height="Auto"/><RowDefinition Height="Auto"/><RowDefinition Height="Auto"/><RowDefinition Height="*"/><RowDefinition Height="Auto"/></Grid.RowDefinitions>
   <DockPanel><TextBlock Name="Heading" Text="WB CLOUD WATCH" FontWeight="Bold" Foreground="#E8BC4C"/><CheckBox Name="Pin" IsChecked="True" Content="Pin" Foreground="#BBBBBB" DockPanel.Dock="Right" HorizontalAlignment="Right"/></DockPanel>
   <TextBlock Name="Health" Grid.Row="1" Text="Waiting for metrics…" FontSize="20" FontWeight="Bold" Margin="0,8,0,4"/>
   <TextBlock Name="Rates" Grid.Row="2" Text="Loading…" TextWrapping="Wrap" FontSize="13"/>
   <TextBlock Name="Freshness" Grid.Row="3" Text="Read-only • refresh every minute" Foreground="#A9AEB4" FontSize="11" Margin="0,7,0,6"/>
   <ScrollViewer Name="DetailPanel" Grid.Row="4" Visibility="Collapsed" VerticalScrollBarVisibility="Auto"><TextBlock Name="Details" TextWrapping="Wrap" FontSize="12"/></ScrollViewer>
   <DockPanel Grid.Row="5"><Button Name="Expand" Content="Details" Padding="9,2" HorizontalAlignment="Left"/><CheckBox Name="Sound" Content="Sound" IsChecked="True" Foreground="#BBBBBB" VerticalAlignment="Center" Margin="14,0,0,0"/></DockPanel>
  </Grid>
 </Border>
</Window>
'@
 $reader=New-Object System.Xml.XmlNodeReader $xaml
 $window=[Windows.Markup.XamlReader]::Load($reader)
 $controls=@{};foreach($name in @('Frame','Heading','Health','Rates','Freshness','Details','DetailPanel','Pin','Sound','Expand')){$controls[$name]=$window.FindName($name)}
 if($Demo){$window.Title='WB Cloud Watch — DEMO';$controls.Heading.Text='WB CLOUD WATCH · DEMO';$controls.Sound.IsChecked=$false}
 $work=[System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea;$window.Left=$work.Right-$window.Width-16;$window.Top=$work.Top+40
 $controls.Pin.Add_Click({$window.Topmost=[bool]$controls.Pin.IsChecked})
 $controls.Expand.Add_Click({if($controls.DetailPanel.Visibility -eq 'Collapsed'){$controls.DetailPanel.Visibility='Visible';$window.Height=440;$controls.Expand.Content='Less'}else{$controls.DetailPanel.Visibility='Collapsed';$window.Height=242;$controls.Expand.Content='Details'}})
 $script:lastAlarm='';$script:lastAlarmAt=[datetime]::MinValue
 $refresh={
  try{
   $s=Get-Content -LiteralPath (Join-Path $DataDir 'status.json') -Raw | ConvertFrom-Json
   $age=([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()-[double]$s.collectedAt)/1000
   $status=if($age -gt 150){'STALE'}else{[string]$s.status}
   $color=switch($status){'NORMAL'{'#52C788'}'WARNING'{'#F0BE46'}'CRITICAL'{'#FF6262'}default{'#A7AEB8'}}
   $title=switch($status){'NORMAL'{'Activity normal'}'WARNING'{'High activity'}'CRITICAL'{'ACTIVITY SPIKE'}'STALE'{'Monitor is offline'}'NO_RECENT_DATA'{'No recent metrics'}default{'Metrics unavailable'}}
   $controls.Health.Text=$title;$controls.Health.Foreground=$color;$controls.Frame.BorderBrush=$color
   $photo=if($s.photo){'{0:N0}/min' -f $s.photo.count}else{'No recent traffic'}
   $reads=if($s.reads){'{0:N0}' -f $s.reads.count}else{'—'};$writes=if($s.writes){'{0:N0}' -f $s.writes.count}else{'—'}
   $cause=if(@($s.alerts).Count -gt 0){[string]$s.alerts[0]+"`n"}else{''}
   $controls.Rates.Text=$cause+"Photo fallback: $photo`nFirestore: $reads reads · $writes writes /min"
   $sample=if($s.sampleAt){([DateTimeOffset]::FromUnixTimeMilliseconds([long]$s.sampleAt)).ToLocalTime().ToString('h:mm tt')}else{'not available'}
   $controls.Freshness.Text="Cloud sample: $sample · checked $([int]$age)s ago"
   $lines=@('wellbuilt-sync · read-only','Google metrics can lag by several minutes.','')
   $lines+=@($s.alerts);$lines+=@($s.errors);$lines+=@($s.functions|ForEach-Object{'{0}: {1:N0}/min ({2} server errors)' -f $_.name,$_.count,$_.errors})
   $controls.Details.Text=$lines -join "`n"
   if(-not $Demo -and $controls.Sound.IsChecked -and $status -eq 'CRITICAL'){
    $key=@($s.alerts)-join '|';if($key -ne $script:lastAlarm -or ([datetime]::Now-$script:lastAlarmAt).TotalMinutes -ge 5){[System.Media.SystemSounds]::Exclamation.Play();$script:lastAlarm=$key;$script:lastAlarmAt=[datetime]::Now}
   }elseif($status -eq 'NORMAL'){$script:lastAlarm=''}
  }catch{$controls.Health.Text='Waiting for metrics…';$controls.Frame.BorderBrush='#A7AEB8';$controls.Rates.Text='No fresh data yet. Open Details if this continues.';$controls.Details.Text='Collector/sign-in unavailable. No live status is being claimed.'}
 }
 $timer=New-Object Windows.Threading.DispatcherTimer;$timer.Interval=[TimeSpan]::FromSeconds(3);$timer.Add_Tick($refresh);$timer.Start();& $refresh
 $window.Add_Closed({$timer.Stop()})
 $window.ShowDialog()|Out-Null
}finally{
 if($collector -and -not $collector.HasExited){$collector.Kill()}
 $mutex.ReleaseMutex();$mutex.Dispose()
}
