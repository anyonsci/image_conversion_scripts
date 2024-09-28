#!/bin/bash

IFS=$'\n'
ext=mp4
files=$(find . -name "*.${ext}") 

for file in $files
do
  codec=$(ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of csv=p=0 "$file")
  if [[ $codec != "av1" ]]; then
    ffmpeg -i "$file" -c:v libsvtav1 -crf 30 -c:s copy -c:a copy "${file%.${ext}}.av1.mp4"
    exit_code=$?
    if [ ${exit_code} -eq 0 ]; then 
      echo "successfully converted ${file}"
      rm "$file"
    else
      echo "Error: converting failed for ${file}" 
    fi
  else
    echo "${file} codec is av1"
  fi
done
