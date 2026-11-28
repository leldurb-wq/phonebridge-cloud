-- Enable narrowly-scoped device controls and live device status.
alter table public.device_commands drop constraint if exists device_commands_action_check;
alter table public.device_commands
  add constraint device_commands_action_check
  check (action in ('system_info','screen_capture','list_files','read_file','write_file','create_folder','launch_app','set_brightness','open_settings','refresh_info','volume_up','volume_down','volume_mute'));
