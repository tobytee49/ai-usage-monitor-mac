// Native AppKit status item. Runtime dispatch avoids a proprietary SDK in the
// Linux cross-build; all APIs below are public AppKit/Foundation APIs.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <time.h>
#include <dlfcn.h>
#include <sys/file.h>
#include <fcntl.h>
#include <unistd.h>
#include <signal.h>
#include <sys/stat.h>

typedef void *ID;
typedef void *SEL;
typedef void (*IMP)(void);
static ID (*cls)(const char*);
static SEL (*sel)(const char*);
static void *send;
static ID app, delegate, menu, item, task;
static char engine[4096], statusFile[4096], installed[4096];
static int pending = 0;
static time_t statusSeconds = 0;
static long statusNanos = 0;
static double nextExpiry = 0;
typedef struct { double x,y; } Point;
typedef struct { double width,height; } Size;
typedef struct { Point origin; Size size; } Rect;
static ID msg(ID o, const char *s) { return ((ID(*)(ID,SEL))send)(o,sel(s)); }
static ID arg(ID o, const char *s, ID a) { return ((ID(*)(ID,SEL,ID))send)(o,sel(s),a); }
static void boolean(ID o,const char*s,int a){ ((void(*)(ID,SEL,signed char))send)(o,sel(s),(signed char)a); }
static ID str(const char*s){return arg(cls("NSString"),"stringWithUTF8String:",(ID)s);}
static const char *utf(ID s){return s?(const char*)msg(s,"UTF8String"):"";}
static ID get(ID o,const char*k){return arg(o,"objectForKey:",str(k));}
static ID jsonFile(const char *path){
  ID data=arg(cls("NSData"),"dataWithContentsOfFile:",str(path));
  if(!data)return NULL;
  return ((ID(*)(ID,SEL,ID,unsigned long,ID))send)(cls("NSJSONSerialization"),sel("JSONObjectWithData:options:error:"),data,0,NULL);
}
static ID newTask(const char *command){
  ID t=msg(msg(cls("NSTask"),"alloc"),"init");
  arg(t,"setLaunchPath:",str(engine));
  ID args=((ID(*)(ID,SEL,ID,ID))send)(cls("NSArray"),sel("arrayWithObjects:"),str(command),NULL);
  arg(t,"setArguments:",args);
  // No pipes: avoids blocked child output and never reads credential output.
  ID null=msg(cls("NSFileHandle"),"fileHandleWithNullDevice");
  arg(t,"setStandardOutput:",null);arg(t,"setStandardError:",null);
  signed char ok=((signed char(*)(ID,SEL,ID))send)(t,sel("launchAndReturnError:"),NULL);
  return ok?t:NULL;
}
static void add(const char*title,const char*action,int enabled){
  ID i=msg(cls("NSMenuItem"),"alloc");
  i=((ID(*)(ID,SEL,ID,SEL,ID))send)(i,sel("initWithTitle:action:keyEquivalent:"),str(title),action?sel(action):NULL,str(""));
  if(action)arg(i,"setTarget:",delegate);
  boolean(i,"setEnabled:",enabled);
  arg(menu,"addItem:",i);
  msg(i,"release");
}
static void separator(){arg(menu,"addItem:",msg(cls("NSMenuItem"),"separatorItem"));}
// Semantic AppKit colours adapt to light/dark and increased contrast.
static double menuWidth=400;
static ID colour(const char *role){
  const char *name=!strcmp(role,"capacity")?"systemBlueColor":!strcmp(role,"healthy")?"systemGreenColor":!strcmp(role,"attention")?"systemOrangeColor":!strcmp(role,"problem")?"systemRedColor":!strcmp(role,"secondary")?"secondaryLabelColor":"labelColor";
  return msg(cls("NSColor"),name);
}
static ID field(const char *text,double size,int bold,const char *role){
  ID f=arg(cls("NSTextField"),"labelWithString:",str(text));
  arg(f,"setTextColor:",colour(role));
  ID font=((ID(*)(ID,SEL,double))send)(cls("NSFont"),sel(bold?"boldSystemFontOfSize:":"menuFontOfSize:"),size);
  arg(f,"setFont:",font);msg(f,"sizeToFit");return f;
}
static double width(ID f){return ((Rect(*)(ID,SEL))send)(f,sel("frame")).size.width;}
static void place(ID v,ID f,double x,double y){
  Rect r=((Rect(*)(ID,SEL))send)(f,sel("frame"));r.origin.x=x;r.origin.y=y;
  ((void(*)(ID,SEL,Rect))send)(f,sel("setFrame:"),r);arg(v,"addSubview:",f);
}
static ID rowView(double height){Rect r={{0,0},{menuWidth,height}};return ((ID(*)(ID,SEL,Rect))send)(msg(cls("NSView"),"alloc"),sel("initWithFrame:"),r);}
static void appendView(ID view,const char *text){
  ID row=((ID(*)(ID,SEL,ID,SEL,ID))send)(msg(cls("NSMenuItem"),"alloc"),sel("initWithTitle:action:keyEquivalent:"),str(text),NULL,str(""));
  arg(row,"setView:",view);arg(menu,"addItem:",row);msg(row,"release");msg(view,"release");
}
static void labelRole(const char *text,int heading,const char *role){
  if(!*text)return;
  ID f=field(text,!strcmp(role,"secondary")?12:13,heading,role);
  Rect r=((Rect(*)(ID,SEL))send)(f,sel("frame"));
  ID v=rowView(r.size.height+4);place(v,f,14,2);appendView(v,text);
}
static void label(const char *text,int heading){labelRole(text,heading,"neutral");}
static ID displayFor(ID row){
  ID expiry=get(row,"validUntil");
  double end=expiry?((double(*)(ID,SEL))send)(expiry,sel("doubleValue")):0;
  return get(row,time(NULL)<end?"currentDisplay":"outdatedDisplay");
}
static void capacityLabel(ID d,const char *fallback){
  const char *name=utf(get(d,"label")),*value=utf(get(d,"value")),*status=utf(get(d,"status")),*detail=utf(get(d,"detail")),*role=utf(get(d,"role")),*state=utf(get(d,"state"));
  int extra=*status||*detail;
  ID left=field(name,13,0,"neutral"),right=field(value,13,1,role);
  ID numericFont=((ID(*)(ID,SEL,double,double))send)(cls("NSFont"),sel("monospacedDigitSystemFontOfSize:weight:"),13.0,0.3);
  arg(right,"setFont:",numericFont);msg(right,"sizeToFit");
  ID v=rowView(extra?40:23);place(v,left,14,extra?21:3);place(v,right,menuWidth-14-width(right),extra?21:3);
  if(extra){
    ID reset=field(detail,12,0,"secondary");place(v,reset,14,3);
    char note[1024];const char *symbol=!strcmp(state,"outdated")||!strcmp(state,"low")?"⚠ ":!strcmp(state,"exhausted")?"! ":"✓ ";
    if(!strcmp(state,"unavailable"))symbol="";
    snprintf(note,sizeof note,"%s%s",symbol,status);
    ID info=field(note,12,0,!strcmp(state,"outdated")?"attention":!strcmp(state,"low")?"attention":!strcmp(state,"exhausted")?"problem":!strcmp(state,"unavailable")?"neutral":"healthy");
    place(v,info,menuWidth-14-width(info),3);
  }
  appendView(v,fallback);
}
// Mirrors lastCheckedLine in local-status.mjs; recomputed each time the menu opens.
static void relativeAge(double ms,char *out,size_t n){
  long m=ms<0?0:(long)(ms/60000);
  if(m<1){snprintf(out,n,"just now");return;}
  long v=m<60?m:m<1440?m/60:m/1440;const char *u=m<60?"minute":m<1440?"hour":"day";
  snprintf(out,n,"%ld %s%s ago",v,u,v==1?"":"s");
}
static void lastChecked(ID snapshot){
  const char *done=utf(get(snapshot,"completedAt")),*outcome=utf(get(snapshot,"outcome"));
  struct tm t;memset(&t,0,sizeof t);
  if(sscanf(done,"%d-%d-%dT%d:%d:%d",&t.tm_year,&t.tm_mon,&t.tm_mday,&t.tm_hour,&t.tm_min,&t.tm_sec)!=6){labelRole("Not checked yet",0,"attention");return;}
  t.tm_year-=1900;t.tm_mon-=1;
  double age=difftime(time(NULL),timegm(&t))*1000;
  char rel[64],line[160];relativeAge(age,rel,sizeof rel);
  if(age>45*60000.0){snprintf(line,sizeof line,"Not checked recently · last %s",rel);labelRole(line,0,"attention");}
  else if(!strcmp(outcome,"failed")){snprintf(line,sizeof line,"Last check failed · %s",rel);labelRole(line,0,"problem");}
  else if(!strcmp(outcome,"partial")){snprintf(line,sizeof line,"Last checked: %s · some checks failed",rel);labelRole(line,0,"attention");}
  else{snprintf(line,sizeof line,"Last checked: %s",rel);labelRole(line,0,"secondary");}
}
static void rebuild(void){
  ID pool=msg(msg(cls("NSAutoreleasePool"),"alloc"),"init");
  msg(menu,"removeAllItems");
  ID snapshot=jsonFile(statusFile);
  int live=task && ((signed char(*)(ID,SEL))send)(task,sel("isRunning"));
  ID syncing=get(snapshot,"syncing");
  int background=syncing && ((signed char(*)(ID,SEL))send)(syncing,sel("boolValue"));
  if(background){ID p=get(snapshot,"ownerPid");int pid=p?(int)((long(*)(ID,SEL))send)(p,sel("integerValue")):0; background=pid>0 && (kill(pid,0)==0);}
  ID rows=get(snapshot,"rows");
  unsigned long count=rows?((unsigned long(*)(ID,SEL))send)(rows,sel("count")):0;
  menuWidth=400;
  for(unsigned long n=0;n<count;n++){
    ID row=((ID(*)(ID,SEL,unsigned long))send)(rows,sel("objectAtIndex:"),n),d=displayFor(row);
    double needed;
    if(d){
      double primary=width(field(utf(get(d,"label")),13,0,"neutral"))+width(field(utf(get(d,"value")),13,1,"neutral"))+56;
      double secondary=width(field(utf(get(d,"detail")),12,0,"neutral"))+width(field(utf(get(d,"status")),12,0,"neutral"))+70;
      needed=primary>secondary?primary:secondary;
    }else needed=width(field(utf(get(row,"text")),13,0,"neutral"))+28;
    if(needed>menuWidth)menuWidth=needed;
  }
  label("AI Usage Monitor",1);
  lastChecked(snapshot);
  if(live||background)label("Checking…",0);
  else if(pending)labelRole(pending==1?"Check now could not start":pending==2?"Some tool checks failed":"Already checking",0,"attention");
  separator();
  nextExpiry=0;
  for(unsigned long n=0;n<count;n++){
    ID row=((ID(*)(ID,SEL,unsigned long))send)(rows,sel("objectAtIndex:"),n);
    if(get(row,"separator")){separator();continue;}
    ID text=get(row,"text");
    ID expiry=get(row,"validUntil");
    if(expiry){double end=((double(*)(ID,SEL))send)(expiry,sel("doubleValue"));text=get(row,time(NULL)<end?"currentText":"outdatedText");if(end>time(NULL)&&(!nextExpiry||end<nextExpiry))nextExpiry=end;}
    ID d=displayFor(row);
    if(d)capacityLabel(d,utf(text));
    else labelRole(utf(text),get(row,"heading")!=NULL,get(row,"secondary")?"secondary":get(row,"role")?utf(get(row,"role")):"neutral");
  }
  if(!count)label("Readings unavailable",0);
  separator();add("Check now","checkNow:",!live&&!background);
  add("Open full dashboard","dashboard:",1);
  separator();add("Uninstall AI Usage Monitor…","uninstallApp:",!live&&!background);add("Quit","quit:",1);
  struct stat state;
  if(stat(statusFile,&state)==0){statusSeconds=state.st_mtimespec.tv_sec;statusNanos=state.st_mtimespec.tv_nsec;}
  msg(pool,"drain");
}
static void checkNow(ID self,SEL cmd,ID sender){
  (void)self;(void)cmd;(void)sender;
  if(task&&((signed char(*)(ID,SEL))send)(task,sel("isRunning")))return;
  task=newTask("menu-sync");pending=task?0:1;rebuild();
}
static void dashboard(ID self,SEL cmd,ID sender){
  (void)self;(void)cmd;(void)sender;
  ID url=arg(cls("NSURL"),"URLWithString:",str("https://ambient-ai-watch.lovable.app/dashboard"));
  arg(msg(cls("NSWorkspace"),"sharedWorkspace"),"openURL:",url);
}
static void uninstallApp(ID self,SEL cmd,ID sender){
  (void)self;(void)cmd;(void)sender;
  if(task&&((signed char(*)(ID,SEL))send)(task,sel("isRunning")))return;
  // The engine confirms, verifies ownership, then stops this menu itself.
  ID t=newTask("uninstall");if(t)msg(t,"release");else{pending=1;rebuild();}
}
static void quit(ID self,SEL cmd,ID sender){(void)self;(void)cmd;(void)sender;arg(app,"terminate:",NULL);}
static void update(ID self,SEL cmd,ID sender){(void)self;(void)cmd;(void)sender;rebuild();}
static void tick(ID self,SEL cmd,ID timer){
  (void)self;(void)cmd;(void)timer;
  if(task&&!((signed char(*)(ID,SEL))send)(task,sel("isRunning"))){
    int exit=((int(*)(ID,SEL))send)(task,sel("terminationStatus"));
    if(exit==75)pending=3;else if(exit!=0)pending=2;else pending=0;
    msg(task,"release");task=NULL;rebuild();
  }
  struct stat state;
  if(stat(statusFile,&state)==0&&(state.st_mtimespec.tv_sec!=statusSeconds||state.st_mtimespec.tv_nsec!=statusNanos)){pending=0;rebuild();}
  else if(nextExpiry&&time(NULL)>=nextExpiry)rebuild();
}
int main(int argc,char **argv){
  (void)argc;(void)argv;
  dlopen("/System/Library/Frameworks/AppKit.framework/AppKit",RTLD_NOW|RTLD_GLOBAL);
  void *objc=dlopen("/usr/lib/libobjc.A.dylib",RTLD_NOW|RTLD_GLOBAL);
  if(!objc)return 1;
  cls=dlsym(objc,"objc_getClass");sel=dlsym(objc,"sel_registerName");send=dlsym(objc,"objc_msgSend");
  ID pool=msg(msg(cls("NSAutoreleasePool"),"alloc"),"init");
  const char *home=getenv("HOME");if(!home)return 1;
  snprintf(installed,sizeof installed,"%s/Library/Application Support/AI Usage Monitor/AI Usage Monitor.app",home);
  const char *bundle=utf(msg(msg(cls("NSBundle"),"mainBundle"),"bundlePath"));
  snprintf(engine,sizeof engine,"%s/Contents/Resources/aum-collector",bundle);
  if(strcmp(bundle,installed)!=0){task=newTask("install-menu");return task?0:1;}
  char lock[4096];snprintf(lock,sizeof lock,"%s/.aum/menu.lock",home);
  int fd=open(lock,O_CREAT|O_RDWR,0600);
  if(fd<0||flock(fd,LOCK_EX|LOCK_NB)!=0)return 0;
  snprintf(statusFile,sizeof statusFile,"%s/.aum/status.json",home);
  app=msg(cls("NSApplication"),"sharedApplication");
  ((signed char(*)(ID,SEL,long))send)(app,sel("setActivationPolicy:"),1);
  ID (*allocate)(ID,const char*,size_t)=dlsym(objc,"objc_allocateClassPair");
  void (*registerClass)(ID)=dlsym(objc,"objc_registerClassPair");
  signed char (*method)(ID,SEL,IMP,const char*)=dlsym(objc,"class_addMethod");
  ID dc=allocate(cls("NSObject"),"AUMMenuDelegate",0);
  method(dc,sel("checkNow:"),(IMP)checkNow,"v@:@");method(dc,sel("dashboard:"),(IMP)dashboard,"v@:@");
  method(dc,sel("quit:"),(IMP)quit,"v@:@");method(dc,sel("uninstallApp:"),(IMP)uninstallApp,"v@:@");method(dc,sel("menuNeedsUpdate:"),(IMP)update,"v@:@");
  method(dc,sel("tick:"),(IMP)tick,"v@:@");registerClass(dc);
  delegate=msg(msg(dc,"alloc"),"init");
  menu=arg(msg(cls("NSMenu"),"alloc"),"initWithTitle:",str("AI Usage Monitor"));
  boolean(menu,"setAutoenablesItems:",0);arg(menu,"setDelegate:",delegate);
  ID bar=msg(cls("NSStatusBar"),"systemStatusBar");
  item=((ID(*)(ID,SEL,double))send)(bar,sel("statusItemWithLength:"),-1.0);
  ID button=msg(item,"button");
  ID image=((ID(*)(ID,SEL,ID,ID))send)(cls("NSImage"),sel("imageWithSystemSymbolName:accessibilityDescription:"),str("chart.bar.xaxis"),str("AI Usage Monitor"));
  if(image){boolean(image,"setTemplate:",1);arg(button,"setImage:",image);}else arg(button,"setTitle:",str("AI"));
  arg(button,"setToolTip:",str("AI Usage Monitor"));arg(item,"setMenu:",menu);rebuild();
  ID timer=((ID(*)(ID,SEL,double,ID,SEL,ID,signed char))send)(cls("NSTimer"),sel("timerWithTimeInterval:target:selector:userInfo:repeats:"),1.0,delegate,sel("tick:"),NULL,1);
  ((void(*)(ID,SEL,ID,ID))send)(msg(cls("NSRunLoop"),"mainRunLoop"),sel("addTimer:forMode:"),timer,str("kCFRunLoopCommonModes"));
  msg(app,"run");msg(pool,"drain");close(fd);return 0;
}