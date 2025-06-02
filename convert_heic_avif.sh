#!/bin/bash

IFS=$'\n'
ext=HEIC
files=$(find . -name "*.${ext}") 

for file in $files
do
  ## auto-orient if the file has orientation data or is JPG format.
  mogrify -auto-orient "$file"
  ## print current file being processed
  # echo $file
  magick "$file" "${file%.${ext}}.avif"
  rm "$file"
done
