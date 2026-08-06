# Travel Empire Asterisk module

The installer copies these isolated include files into `/etc/asterisk` and adds
exactly one include line to each parent configuration. It also creates dated
backups before changing a parent file.

The sales queue times out after 100 seconds (five 20-second advisor attempts)
and records a general voicemail as a callback request. This is a callback
*intake*, not an automatic outbound callback scheduler; the dialer application
must turn the voicemail event into a callback task before automated callbacks
are enabled.

The broadcast DNC key is **9**. It writes an immediate AstDB suppression entry
and emits an AMI `TravelEmpireDNC` user event for CRM synchronization.
