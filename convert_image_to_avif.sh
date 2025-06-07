#!/bin/bash

IFS=$'\n'

input_dir="."
output_dir="."

helpFunction()
{
   echo ""
   echo "Usage: $0 -d input_dir -e file_extension -o output_dir"
   echo -e "\t-d The input directory for the files. Default current directory."
   echo -e "\t-e Extension of the input file."
   echo -e "\t-o The output directory for the files. Default current directory."
   exit 1 # Exit script after printing help
}

while getopts "d:e:o:" opt
do
   case "$opt" in
      d) input_dir="$OPTARG" ;;
      e) ext="$OPTARG" ;;
      o) output_dir="$OPTARG" ;;
      ?) echo "$opt $OPTARG" ;; # Print helpFunction in case parameter is non-existent
   esac
done

# Print helpFunction in case parameters are empty
if [ -z "$ext" ]
then
   echo "-e is required argument";
   helpFunction
fi

# Begin script in case all parameters are correct
files=$(find $input_dir -name "*.${ext}") 

echo "$(find $input_dir -name "*.${ext}" | wc -l) files found"

for file in $files
do
  ## print current file being processed
  # echo $file
  relative_path="${file#"$input_dir/"}"
  relative_dir=$(dirname "$relative_path")
  if [ "$relative_dir" = "." ]; then # Handle case where file is in root input_dir
    relative_dir=""
  fi
  output_parent_dir="$output_dir"
  if [ -n "$relative_dir" ]; then # Only append if there's a subdirectory path
      output_parent_dir="$output_dir/$relative_dir"
  fi

  mkdir -p "$output_parent_dir" || { echo "Error: Could not create output subdirectory '$output_parent_dir'"; continue; }
  output_file="$output_parent_dir/$(basename ${file%.*}).avif"
  if test -e $output_file; then
    echo "$output_file exists"
    continue
  fi

  ## auto-orient if the file has orientation data or is JPG format.
  mogrify -auto-orient -define preserve-timestamp=true "$file"
  magick -regard-warnings -define preserve-timestamp=true "$file" "$output_file"
  error=$?
  if [ $error -ne 0 ]
  then
    echo "Error: $file was not converted: $error"
  # else
  #   rm "$file"
  fi
done
