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
  magick -regard-warnings "$file" "${file%.${ext}}.avif" /dev/null
  error=$?
  if [ $error -ne 0 ]
  then
    echo "Error: $file was not converted: $error"
  else
    rm "$file"
done
